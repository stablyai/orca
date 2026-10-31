import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { recordingStep } from './recording-step'
import { materializeScenario } from './scenario-execution-mode'
import {
  captureArguments,
  captureValue,
  type RecordedValue,
  type Settlement
} from './recording-values'
import { GITHUB_CONNECTION_CHANGED } from '../../transport/github-target-invocation'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-item-target'
import { operationModuleLoader, type OperationMutation } from './operation-module-loader'
import {
  createBridgePortPair,
  disposeBridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { isKeyedObject, withReplyMeta } from '../bridged-parity/divergence-evidence'
import { pilotMountAdapters } from './pilot-mount-adapters'
import type { RecordingScenario, MountedOperation } from './recording-scenario'
import { readScenarios } from './scenario-input'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)

const probeInputs = [
  [
    'capable',
    {
      ok: true,
      result: {
        runtimeId: 'shell-runtime',
        hostDescriptor: { installationId: 'shell-desktop' },
        capabilities: ['github.exact-work-item-target.v1']
      }
    }
  ],
  ['unsupported', { ok: true, result: { capabilities: [] } }],
  ['malformed', { ok: true, result: 17 }],
  ['result-absent', { ok: true }],
  ['result-null', { ok: true, result: null }],
  ['outer-refused', { ok: false, error: { code: 'refused', message: 'outer refused' } }],
  ['transport-throw', undefined],
  ['deadline', undefined]
] as const

type ProbePartition = (typeof probeInputs)[number][0]
type ProbeLifecycle = 'before-probe' | 'during-probe' | 'between-probe-and-operation'
function probeFailure(partition: ProbePartition, lifecycle: ProbeLifecycle): string {
  if (lifecycle === 'during-probe') {
    return 'RPC interrupted by connection migration'
  }
  if (['malformed', 'result-absent', 'result-null'].includes(partition)) {
    return 'The host sent a reply this app could not read (status.get)'
  }
  if (partition === 'outer-refused') {
    return 'outer refused'
  }
  if (partition === 'transport-throw') {
    return 'transport failure'
  }
  if (partition === 'deadline') {
    return 'Request timed out: status.get'
  }
  return lifecycle === 'before-probe'
    ? GITHUB_EXACT_OPERATION_UNSUPPORTED
    : GITHUB_CONNECTION_CHANGED
}

async function probeCase(
  source: RecordingScenario,
  mode: 'page-original' | 'page-reply-meta',
  partition: ProbePartition,
  lifecycle: ProbeLifecycle,
  mutation?: OperationMutation
) {
  const selected = materializeScenario(source, 'bridge')
  const declaration = selected.steps.find((step) => step.bridgeSite === true)
  if (!declaration || !('complete' in declaration)) {
    throw new Error('Missing original declared probe')
  }
  const operation = selected.bridgeOperations![0]!
  const operationStep = selected.steps.find(
    (step) => 'complete' in step && step.site === operation.request
  )
  if (!operationStep || !('complete' in operationStep)) {
    throw new Error('Missing original operation completion')
  }
  const probeAt = selected.steps.indexOf(declaration)
  let initiatingAction = probeAt
  while (initiatingAction >= 0 && !('action' in selected.steps[initiatingAction]!)) {
    initiatingAction -= 1
  }
  if (initiatingAction < 0) {
    throw new Error('Missing actual initiating action')
  }
  const factory = mutation ? operationModuleLoader(root, mutation) : undefined
  const pairModule = factory?.load<
    typeof import('../../mobile-web-shell/bridge/bridge-port-pair-test-harness')
  >('mobile/src/mobile-web-shell/bridge/bridge-port-pair-test-harness.ts')
  const clock = vitestRecordingScheduler()
  let transport: ScriptedRpcTransport | undefined
  let mounted: MountedOperation | undefined
  let started = false
  let clockAttempted = false
  const effects: { name: string; value: RecordedValue }[] = []
  const checkpoints: { id: string; state: RecordedValue }[] = []
  const settlements: Record<string, Settlement> = {}
  const ids = new Set<string>()
  const failures: unknown[] = []
  const allowed = partition === 'capable' && lifecycle === 'before-probe'
  let baseline: RecordedValue | undefined
  try {
    clockAttempted = true
    await clock.start()
    started = true
    transport = new ScriptedRpcTransport(
      clock.elapsed,
      undefined,
      (rpc, observation) => {
        const pair = (pairModule?.createBridgePortPair ?? createBridgePortPair)({
          rpc,
          observation: observation.openBridge(),
          ...(mode === 'page-reply-meta' ? { rewriteToPage: withReplyMeta } : {})
        })
        observation.onDispose(() =>
          (pairModule?.disposeBridgePortPair ?? disposeBridgePortPair)(pair)
        )
        for (let turn = 0; turn < 4; turn += 1) {
          pair.drainNow()
        }
        return pair.client
      },
      undefined,
      undefined,
      (acquired) => {
        transport = acquired
      }
    )
    const active = transport
    mounted = pilotMountAdapters(root, { device: selected }).adapters[selected.operation]!({
      client: active.client,
      effect: (name, value) => effects.push({ name, value: captureValue(value) })
    })
    for (const [index, originalStep] of selected.steps.entries()) {
      let lateProbeReply: { value: unknown } | undefined
      if (index === initiatingAction) {
        baseline = checkpoints.at(-1)?.state
        if (lifecycle === 'before-probe') {
          await active.cutover()
        }
      }
      if (index === probeAt) {
        const parent = active.requests.find((request) => request.name === operation.request)!
        expect(
          parent.bridge!.posts[0]!.children.map((child) => child.method),
          'actual probe must precede the operation'
        ).toEqual(['status.get'])
        expect(active.outstanding(declaration.complete)).toMatchObject({ params: undefined })
        const child = parent.bridge!.posts[0]!.children[0]!
        const actualPost: unknown = JSON.parse(parent.bridge!.posts[0]!.json)
        if (!isKeyedObject(actualPost)) {
          throw new Error('Missing actual page request')
        }
        expect(actualPost.options).toEqual({ timeoutMs: 30_000, failWhenDisconnected: true })
        expect(child.args).toEqual(
          captureArguments([
            'status.get',
            undefined,
            { timeoutMs: 30_000, failWhenDisconnected: true, beforeSend: () => {} }
          ])
        )
        expect(
          active.payloads
            .filter((row) => row.name.startsWith(`${operation.request}.`))
            .map((row) => JSON.parse(row.json))
        ).toEqual([{ id: child.frame!.id, deviceToken: 'recording-device', method: 'status.get' }])
        if (lifecycle === 'during-probe') {
          await active.cutover()
        }
        if (partition === 'deadline') {
          await clock.advance(30_000)
        } else {
          const replacement = probeInputs.find(([name]) => name === partition)![1]
          if (lifecycle === 'during-probe') {
            if (partition !== 'transport-throw') {
              lateProbeReply = { value: replacement }
            }
          } else {
            active.complete(
              declaration.complete,
              declaration.params,
              replacement,
              partition === 'transport-throw'
                ? { message: 'transport failure', deliveryUnknown: true }
                : undefined
            )
          }
        }
        if (lifecycle === 'between-probe-and-operation') {
          await active.cutover()
        }
      } else if ('advance' in originalStep) {
        await clock.advance(originalStep.advance)
      } else {
        if (originalStep === operationStep) {
          const parent = active.requests.find((request) => request.name === operation.request)!
          const post = parent.bridge!.posts[0]!
          const forwarded = post.children.filter((child) => child.method !== 'status.get')
          expect(
            post.children.map((child) => child.method),
            'exact probe/forward count and order'
          ).toEqual(allowed ? [...operation.methods] : ['status.get'])
          expect(forwarded).toHaveLength(allowed ? 1 : 0)
          if (allowed) {
            const child = forwarded[0]!
            const message: unknown = JSON.parse(post.json)
            if (!isKeyedObject(message) || !isKeyedObject(message.envelope)) {
              throw new Error('Missing actual operation envelope')
            }
            expect(message.params).toEqual(operationStep.params)
            expect(
              active.payloads.find((row) => row.name === child.name)?.json,
              'exact final operation bytes'
            ).toBe(
              JSON.stringify({
                ...message.envelope,
                id: child.frame!.id,
                deviceToken: 'recording-device',
                method: message.method,
                params: operationStep.params
              })
            )
            expect(post.children[0]!.completion!.ordinal).toBeLessThan(child.ordinal)
          }
        }
        if (originalStep === operationStep && !allowed) {
          expect(active.outstanding(operationStep.complete)).toBeUndefined()
        } else {
          recordingStep(
            selected,
            originalStep,
            active,
            mounted,
            settlements,
            clock,
            (name, value) => effects.push({ name, value: captureValue(value) }),
            active.fault,
            ids
          )
        }
      }
      await clock.flush()
      active.check()
      if (lateProbeReply) {
        expect(active.lateReply(declaration.complete, lateProbeReply.value)).toBe(false)
      }
      if ('checkpoint' in originalStep) {
        checkpoints.push({ id: originalStep.checkpoint, state: captureValue(mounted.state()) })
      }
    }
    const parent = active.requests.find((request) => request.name === operation.request)!
    const post = parent.bridge!.posts[0]!
    expect(post.parent).toBe(parent.name)
    expect(post.deliveries).toHaveLength(1)
    expect(post.replies).toHaveLength(1)
    const answer: unknown = JSON.parse(post.replies[0]!.delivered!)
    if (!isKeyedObject(answer)) {
      throw new Error('Missing actual page answer')
    }
    if (allowed) {
      expect(parent.settlement.status).toBe('fulfilled')
      expect(answer).toMatchObject({
        type: 'reply',
        id: post.id,
        payload: {
          ok: true,
          result: isKeyedObject(operationStep.reply) ? operationStep.reply.result : undefined
        }
      })
    } else {
      const message = probeFailure(partition, lifecycle)
      expect(parent.settlement).toMatchObject({
        status: 'rejected',
        error: {
          message,
          isRpcDeliveryUnknown:
            lifecycle === 'during-probe' ||
            partition === 'transport-throw' ||
            partition === 'deadline'
        }
      })
      expect(answer).toMatchObject({ type: 'error', id: post.id, error: { message } })
    }
    const checkpoint = checkpoints.find(
      (row) =>
        row.id ===
        (source.id === 'pr-read-surface'
          ? 'assignable'
          : source.id === 'tk-item-detail-github'
            ? 'mounted'
            : source.id === 'tk-item-status-gitlab'
              ? 'github-metadata-settled'
              : 'issue-state-settled')
    )!
    if (!isKeyedObject(checkpoint.state)) {
      throw new Error('Missing original product state')
    }
    if (source.operation === 'session.pr-reads') {
      expect(checkpoint.state).toEqual({
        ...(isKeyedObject(baseline) ? baseline : {}),
        assignable: captureValue(
          allowed
            ? {
                ok: true,
                result: [{ login: 'octocat', name: 'Octo Cat', avatarUrl: '' }]
              }
            : { ok: false, error: probeFailure(partition, lifecycle) }
        )
      })
      expect(effects).toEqual([])
    } else if (source.operation === 'tasks.item-detail-github') {
      expect(checkpoint.state.loading).toBe(false)
      expect(checkpoint.state.error).toBe(allowed ? '' : probeFailure(partition, lifecycle))
      if (allowed) {
        expect(checkpoint.state.payload).toMatchObject({
          provider: 'github',
          body: 'body',
          comments: [],
          labels: ['bug'],
          assignees: ['octocat'],
          headSha: 'head-sha',
          baseSha: 'base-sha',
          pullRequestId: 'PR_kwDO',
          checks: [],
          files: []
        })
      } else {
        expect(checkpoint.state.payload).toEqual(captureValue(null))
      }
      expect(checkpoint.state.item).toMatchObject({
        title: 'A pull request',
        source: { number: 12, prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' } }
      })
    } else {
      // These actions target an unselected item; the committed selected detail/row must survive either outcome.
      expect(baseline).toBeDefined()
      expect(checkpoint.state).toEqual(baseline)
    }
    expect(checkpoints.map((row) => row.id)).toEqual(
      selected.steps.flatMap((step) => ('checkpoint' in step ? [step.checkpoint] : []))
    )
    expect(
      Object.values(settlements).every((settlement) => settlement.status === 'fulfilled')
    ).toBe(true)
    expect(active.pendingRequests()).toBe(0)
    const fresh = active.client.sendRequest('status.get')
    await clock.flush()
    const freshChild = active.requests.at(-1)!.bridge!.posts[0]!.children[0]!
    active.complete(freshChild.name, undefined, declaration.reply)
    await clock.flush()
    await expect(fresh).resolves.toMatchObject({
      ok: true,
      result: { capabilities: ['github.exact-work-item-target.v1'] }
    })
    expect(active.pendingRequests()).toBe(0)
  } catch (error) {
    failures.push(error)
  } finally {
    if (factory) {
      try {
        expect(factory.mutationsApplied()).toBe(1)
      } catch (error) {
        failures.push(error)
      }
    }
    const cleanups = [
      () => mounted?.dispose(),
      ...(started ? [() => clock.flush()] : []),
      () => transport?.dispose(),
      ...(started ? [() => clock.flush()] : []),
      () => transport?.causality.assertTransparentCalls(),
      () => transport?.causality.close(),
      ...(clockAttempted ? [() => clock.stop()] : [])
    ]
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length) {
    throw new AggregateError(failures, `${source.id}/${partition}/${lifecycle}/${mode}`)
  }
}

it('declared bridge-only probes preserve exact outcomes and never hide later differences', async () => {
  for (const scenarioId of [
    'pr-read-surface',
    'tk-item-detail-github',
    'tk-item-status-gitlab',
    'tk-project-row-files-merge'
  ]) {
    const source = input.scenarios.find((scenario) => scenario.id === scenarioId)
    if (!source) {
      throw new Error(`Missing original pilot ${scenarioId}`)
    }
    for (const mode of ['page-original', 'page-reply-meta'] as const) {
      for (const lifecycle of [
        'before-probe',
        'during-probe',
        'between-probe-and-operation'
      ] as const) {
        for (const [partition] of probeInputs) {
          await probeCase(source, mode, partition, lifecycle)
        }
      }
    }
  }
  const source = input.scenarios.find((scenario) => scenario.id === 'pr-read-surface')!
  // The untouched full producer reaches both the probe and the final operation before either mutant is credited.
  await probeCase(source, 'page-original', 'capable', 'before-probe')
  for (const mutant of [
    {
      name: 'omit-required-first-hop',
      file: 'bridge-host-requests.ts',
      before: 'const status = await invocation.status({ ...options, timeoutMs: remaining() })',
      after: "const status = { capabilities: ['github.exact-work-item-target.v1'] }",
      actual: ['github.listAssignableUsers'],
      expected: ['status.get'],
      partition: 'capable' as const
    },
    {
      name: 'duplicate-required-first-hop',
      file: 'bridge-host-requests.ts',
      before: 'const status = await invocation.status({ ...options, timeoutMs: remaining() })',
      after:
        'const extra = invocation.status({ ...options, timeoutMs: remaining() }); void extra.catch(() => {}); const status = await invocation.status({ ...options, timeoutMs: remaining() })',
      actual: ['status.get', 'status.get'],
      expected: ['status.get'],
      partition: 'capable' as const
    },
    {
      name: 'operation-before-required-first-hop',
      file: 'bridge-host-requests.ts',
      before: 'const status = await invocation.status({ ...options, timeoutMs: remaining() })',
      after:
        'void client.sendRequest(message.method, params, { ...options, envelope: message.envelope }).catch(() => {}); const status = await invocation.status({ ...options, timeoutMs: remaining() })',
      actual: ['github.listAssignableUsers', 'status.get'],
      expected: ['status.get'],
      partition: 'capable' as const
    },
    {
      name: 'unsafe-unsupported-forward',
      file: 'bridge-host-requests.ts',
      before: 'requireExactGitHubOperations(status)',
      after: 'void status',
      actual: ['status.get', 'github.listAssignableUsers'],
      expected: ['status.get'],
      partition: 'unsupported' as const
    }
  ]) {
    let failure: { error: unknown } | undefined
    try {
      await probeCase(source, 'page-original', mutant.partition, 'before-probe', mutant)
    } catch (error) {
      failure = { error }
    }
    expect(failure?.error).toMatchObject({
      name: 'AssertionError',
      actual: mutant.actual,
      expected: mutant.expected
    })
  }
}, 120_000)
