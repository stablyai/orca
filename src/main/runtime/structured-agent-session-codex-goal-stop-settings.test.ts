import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_GOAL_CONTROL_COPY as COPY } from '../../shared/agent-session-goal-control-copy'
import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-thread-goal-wire'
import { CodexAppServerRequestError } from '../codex/app-server/codex-app-server-request-error'
import {
  CODEX_SCRIPTED_THREAD as THREAD,
  codexScriptedChild
} from '../codex/codex-scripted-child.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy
} from '../provider-process/provider-process-close'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

const CALLER = { callerKey: 'goal-stop-settings' }
let root: string | undefined
let operation = 0
const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 10_000 })

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

function envelope(
  host: StructuredAgentSessionHost,
  method: string,
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function openChat(child: ReturnType<typeof codexScriptedChild>) {
  root = await mkdtemp(join(tmpdir(), 'orca-goal-stop-settings-'))
  child.holdHandshakes = false
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root ?? '',
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    ...child.deps
  })
  const params = hostTestAttachParams(null, {
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex') },
    providerHandle: undefined
  })
  params.envelope.clientOperationId = `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await eventually(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  return host
}

const goal = (host: StructuredAgentSessionHost, change: AgentSessionThreadGoalChange) =>
  host.changeThreadGoal(CALLER, {
    envelope: envelope(host, 'agentSession.threadGoal', { change }),
    change
  })
const stop = (host: StructuredAgentSessionHost, turnId?: string) => {
  const fields = turnId ? { turnId } : {}
  return host.cancel(CALLER, { envelope: envelope(host, 'agentSession.cancel', fields), ...fields })
}
const setOption = (host: StructuredAgentSessionHost, key: string, value: string) =>
  host.setOption(CALLER, {
    envelope: envelope(host, 'agentSession.setOption', { key, value }),
    key,
    value
  })
const settleStop = (host: StructuredAgentSessionHost) =>
  host.collaboratorsForTests().serialize(SESSION, async () => {})
async function rows(host: StructuredAgentSessionHost) {
  return (await host.journalSnapshot(SESSION)).items.flatMap((row) =>
    row.body.kind === 'status' ? [row.body.text] : []
  )
}

it('waits for applied saved model/effort before direct Set and Resume, and keeps settings when the goal fails', async () => {
  const reply = Promise.withResolvers<unknown>()
  let child: ReturnType<typeof codexScriptedChild>
  let rejectGoal = false
  child = codexScriptedChild({
    'thread/settings/update': () => reply.promise,
    'thread/goal/set': () => {
      if (rejectGoal) {
        throw new CodexAppServerRequestError('thread/goal/set', -32602, 'refused goal')
      }
      return {}
    }
  })
  const host = await openChat(child)
  expect(await setOption(host, 'model', 'scripted-alt-model')).toMatchObject({ ok: true })
  expect(await setOption(host, 'effort', 'high')).toMatchObject({ ok: true })
  const change = { kind: 'set' as const, objective: 'Use selected settings' }
  const pending = goal(host, change)
  await eventually(() =>
    expect(child.requests().some((r) => r.method === 'thread/settings/update')).toBe(true)
  )
  reply.resolve({})
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toEqual([])
  child.notify('thread/settings/updated', {
    threadId: 'unrelated',
    threadSettings: { model: 'scripted-alt-model', effort: 'high' }
  })
  await Promise.resolve()
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toEqual([])
  child.notify('thread/settings/updated', {
    threadId: THREAD,
    threadSettings: { model: 'scripted-alt-model', effort: 'high' }
  })
  expect(await pending).toMatchObject({ ok: true })
  expect(child.requests().find((r) => r.method === 'thread/settings/update')?.params).toEqual({
    threadId: THREAD,
    model: 'scripted-alt-model',
    effort: 'high'
  })
  rejectGoal = true
  expect(await goal(host, { kind: 'status', status: 'active' })).toMatchObject({ ok: false })
  rejectGoal = false
  expect(await goal(host, { kind: 'status', status: 'active' })).toMatchObject({ ok: true })
  expect(child.requests().filter((r) => r.method === 'thread/settings/update')).toHaveLength(1)
})

it.each(['rejected', 'unsupported'] as const)(
  'keeps pre-goal %s effects definite through host settlement',
  async (mode) => {
    const child = codexScriptedChild({
      'thread/settings/update': () => {
        throw new CodexAppServerRequestError(
          'thread/settings/update',
          mode === 'unsupported' ? -32601 : -32602,
          mode
        )
      }
    })
    const host = await openChat(child)
    await setOption(host, 'model', 'scripted-alt-model')
    const result = await goal(host, {
      kind: 'set',
      objective: 'Do not erase a goal for a settings failure'
    })
    expect(result.ok).toBe(mode === 'unsupported')
    expect(child.requests().some((r) => r.method === 'thread/goal/set')).toBe(
      mode === 'unsupported'
    )
    expect(child.requests().some((r) => r.method === 'thread/goal/clear')).toBe(false)
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.some((r) => r.body.kind === 'message' && r.body.sentAs === 'goal')).toBe(
      mode === 'unsupported'
    )
  }
)

it.each([null, 'complete'] as const)(
  'repairs a model-created goal after the first %s read without warning on acknowledged shutdown',
  async (initial) => {
    let state: string | null = initial
    let reads = 0
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        const observed = state
        if (++reads === 1) {
          state = 'active'
        }
        return { goal: observed === null ? null : { status: observed } }
      },
      'thread/goal/set': (params) => {
        state = String(params?.status)
        return { goal: { status: state } }
      }
    })
    const host = await openChat(child)
    const request = { envelope: envelope(host, 'agentSession.cancel', {}) }
    expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
    await settleStop(host)
    expect(child.closes()).toBe(1)
    expect(state).toBe('paused')
    expect(
      child
        .requests()
        .filter((r) => r.method.startsWith('thread/goal/'))
        .map((r) => r.method)
    ).toEqual(['thread/goal/get', 'thread/goal/get', 'thread/goal/set'])
    expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
    const calls = child.requests().length
    expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
    expect(child.requests()).toHaveLength(calls)
  }
)

it.each(['disabled', 'unavailable'] as const)(
  'keeps an initially %s goal read inapplicable',
  async (mode) => {
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        throw new CodexAppServerRequestError(
          'thread/goal/get',
          mode === 'disabled' ? -32600 : -32601,
          mode === 'disabled' ? 'goals feature is disabled' : 'Method not found'
        )
      }
    })
    const host = await openChat(child)
    expect(await stop(host)).toMatchObject({ ok: true })
    await settleStop(host)
    expect(
      child
        .requests()
        .filter((r) => r.method.startsWith('thread/goal/'))
        .map((r) => r.method)
    ).toEqual(['thread/goal/get'])
    expect(child.closes()).toBe(1)
    expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
    expect(await rows(host)).not.toContain(COPY.stopUnconfirmed)
  }
)

it.each(['no-observer', 'replacement'] as const)(
  'keeps missing captured-close evidence unproven for %s',
  async (mode) => {
    const child = codexScriptedChild({ 'thread/goal/get': () => ({ goal: null }) })
    const host = await openChat(child)
    const session = host.collaboratorsForTests().sessions.get(SESSION)!
    const captured = session.child!
    const cancel = host.deps.adapter.cancelTurn.bind(host.deps.adapter)
    let outcome: Awaited<ReturnType<typeof cancel>>['stop']
    vi.spyOn(host.deps.adapter, 'cancelTurn').mockImplementation(async (input) => {
      const result = await cancel(input)
      outcome = result.stop
      if (mode === 'replacement') {
        session.child = { ...captured, generation: 'replacement', close: undefined }
      }
      return result
    })
    const dispose = vi.spyOn(host.deps.adapter, 'disposeSession').mockResolvedValue(true)
    expect(await stop(host)).toMatchObject({ ok: true })
    await settleStop(host)
    expect(outcome).toMatchObject({
      pause: 'acknowledged',
      root: 'unproven',
      workload: 'unproven',
      errors: []
    })
    expect(await rows(host)).toContain(COPY.stopUnconfirmed)
    if (mode === 'replacement') {
      expect(dispose).not.toHaveBeenCalled()
      expect(session.child).toMatchObject({ generation: 'replacement' })
      expect(session.child?.close).toBeUndefined()
      session.child = captured
    } else {
      expect(dispose).toHaveBeenCalledOnce()
    }
  }
)

it.each([
  'pause',
  'first-pause',
  'unavailable-pause',
  'disabled-pause',
  'interrupt',
  'disabled-interrupt',
  'workload',
  'root',
  'named-root',
  'note'
] as const)(
  'retains %s failure after shutdown, including turnless work and strict note failure',
  async (failure) => {
    const rootFailure = failure === 'root' || failure === 'named-root'
    const stopCurrent = (host: StructuredAgentSessionHost) =>
      stop(host, failure === 'named-root' ? 'autonomous' : undefined)
    let pauses = 0
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        if (failure === 'disabled-interrupt') {
          throw new CodexAppServerRequestError(
            'thread/goal/get',
            -32600,
            'goals feature is disabled'
          )
        }
        return { goal: { status: 'active' } }
      },
      'thread/goal/set': () => {
        if (failure === 'unavailable-pause' || failure === 'disabled-pause') {
          throw new CodexAppServerRequestError(
            'thread/goal/set',
            failure === 'unavailable-pause' ? -32601 : -32600,
            failure === 'disabled-pause' ? 'goals feature is disabled' : 'Method not found'
          )
        }
        if (
          failure === 'pause' ||
          failure === 'note' ||
          ((failure === 'first-pause' || rootFailure) && ++pauses === 1)
        ) {
          throw new CodexAppServerRequestError('thread/goal/set', -32602, 'refused')
        }
        return { goal: { status: 'paused' } }
      },
      ...(['named-root', 'unavailable-pause', 'disabled-pause'].includes(failure)
        ? { 'turn/interrupt': () => ({}) }
        : {}),
      ...(failure === 'interrupt' || failure === 'disabled-interrupt'
        ? {
            'turn/interrupt': () => {
              throw new Error('lost interrupt')
            }
          }
        : {})
    })
    const host = await openChat(child)
    if (
      failure === 'interrupt' ||
      failure === 'disabled-interrupt' ||
      failure === 'named-root' ||
      failure === 'unavailable-pause' ||
      failure === 'disabled-pause'
    ) {
      child.notify('turn/started', { threadId: THREAD, turn: { id: 'autonomous' } })
    }
    if (failure === 'workload') {
      child.closeEvidence = { root: 'exited', tree: 'unverifiable' }
    }
    if (rootFailure) {
      vi.spyOn(host.deps.adapter, 'disposeSession').mockResolvedValue(false)
    }
    if (failure === 'note') {
      const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
      if (!journal) {
        throw new Error('missing journal')
      }
      const releaseNote = Promise.withResolvers<void>()
      const append = journal.appendLifecycleBatch.bind(journal)
      vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((batch) => {
        if (batch.settlementId.startsWith('stop-outcome:')) {
          return releaseNote.promise.then(() => {
            throw new Error('note store unavailable')
          })
        }
        return append(batch)
      })
      const logged = vi.spyOn(host.deps.logger, 'warn')
      const request = { envelope: envelope(host, 'agentSession.cancel', {}) }
      expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
      releaseNote.resolve() // Strict warning write fails only after the accepted reply.
      await settleStop(host)
      expect(logged).toHaveBeenCalledWith(
        'ending the agent process on Stop failed',
        expect.objectContaining({
          sessionId: SESSION,
          operationId: request.envelope.clientOperationId,
          error: expect.objectContaining({ message: 'note store unavailable' })
        })
      )
      expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
    } else {
      expect(await stopCurrent(host)).toMatchObject({ ok: true })
      await settleStop(host)
      expect(await rows(host)).toContain(
        failure === 'pause' ||
          failure === 'first-pause' ||
          failure === 'unavailable-pause' ||
          failure === 'disabled-pause'
          ? COPY.pauseUnconfirmed
          : COPY.stopUnconfirmed
      )
      if (failure === 'unavailable-pause' || failure === 'disabled-pause') {
        expect(
          child
            .requests()
            .filter((r) => r.method.startsWith('thread/goal/'))
            .map((r) => r.method)
        ).toEqual(['thread/goal/get', 'thread/goal/set', 'thread/goal/get', 'thread/goal/set'])
        expect(child.requests().filter((r) => r.method === 'turn/interrupt')).toHaveLength(1)
      }
      if (rootFailure) {
        expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.close).toBeDefined()
        const before = (await host.journalSnapshot(SESSION)).items.filter(
          (r) => r.body.kind === 'status' && r.body.text === COPY.stopUnconfirmed
        )
        expect(before).toHaveLength(1)
        const firstOutcome = host.collaboratorsForTests().sessions.get(SESSION)?.child
          ?.close?.stopOutcome
        const controls = child.requests().length
        const firstErrors = firstOutcome?.errors.slice()
        const attempts = failure === 'root' ? 100 : 1000
        const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
        const appended = vi.spyOn(journal, 'appendLifecycleBatch')
        const logged = vi.spyOn(host.deps.logger, 'warn').mockImplementation(() => {})
        const operations = new Set<string>()
        for (let retry = 0; retry < attempts; retry++) {
          const request = {
            envelope: envelope(
              host,
              'agentSession.cancel',
              failure === 'named-root' ? { turnId: 'autonomous' } : {}
            ),
            ...(failure === 'named-root' ? { turnId: 'autonomous' } : {})
          }
          operations.add(request.envelope.clientOperationId)
          expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true, replayed: false })
          await settleStop(host)
          expect(
            host.deps.store.readCommandReceipt(
              { kind: 'caller', callerKey: CALLER.callerKey },
              request.envelope.clientOperationId
            ).verdict
          ).toBe('readable')
          expect(firstOutcome?.errors).toEqual(firstErrors)
          expect(firstOutcome?.errors[0]).toBe(firstErrors?.[0])
        }
        expect(operations.size).toBe(attempts)
        const settlements = appended.mock.calls
          .map(([batch]) => batch.settlementId)
          .filter((id) => id.startsWith('stop-outcome:'))
        expect(new Set(settlements).size).toBe(attempts)
        expect(
          logged.mock.calls.filter(
            ([message]) => message === "ending a stopped chat's provider session failed"
          )
        ).toHaveLength(attempts)
        expect(firstErrors).toHaveLength(1)
        expect(firstErrors?.[0]).toMatchObject({ method: 'thread/goal/set', message: 'refused' })
        expect((await rows(host)).filter((text) => text === COPY.stopUnconfirmed)).toHaveLength(1)
        expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.close?.stopOutcome).toBe(
          firstOutcome
        )
        vi.mocked(host.deps.adapter.disposeSession!).mockRestore()
        expect(await stopCurrent(host)).toMatchObject({ ok: true })
        await settleStop(host)
        expect(child.requests()).toHaveLength(controls)
        const after = (await host.journalSnapshot(SESSION)).items.filter(
          (r) => r.body.kind === 'status' && r.body.failure?.kind === 'cancelUnconfirmed'
        )
        expect(after).toHaveLength(1)
        expect(after[0].body).toMatchObject({ text: COPY.pauseUnconfirmed })
        expect(after[0].itemId).toBe(before[0].itemId)
        expect(firstOutcome).toMatchObject({
          pause: 'unconfirmed',
          root: 'exited',
          workload: 'exited'
        })
        expect(firstOutcome?.errors).toEqual(firstErrors)
      } else {
        expect(child.closes()).toBe(1)
      }
    }
  },
  60_000
)

it('pauses before resolving an autonomous turn and interrupts before the final goal read', async () => {
  const child = codexScriptedChild({
    'thread/goal/get': () => ({ goal: { status: 'active' } }),
    'thread/goal/set': () => {
      child.notify('turn/started', { threadId: THREAD, turn: { id: 'newest' } })
      return { goal: { status: 'paused' } }
    }
  })
  const host = await openChat(child)
  expect(await stop(host)).toMatchObject({ ok: true })
  await settleStop(host)
  const calls = child
    .requests()
    .filter((r) => r.method === 'turn/interrupt' || r.method.startsWith('thread/goal/'))
  expect(calls.map((r) => r.method)).toEqual([
    'thread/goal/get',
    'thread/goal/set',
    'turn/interrupt',
    'thread/goal/get',
    'thread/goal/set'
  ])
  expect(calls[2].params?.turnId).toBe('newest')
  expect(child.closes()).toBe(1)
})

it.each(['first-read', 'interrupt'] as const)(
  'bounds %s by original Stop grace and still closes the child',
  async (hung) => {
    const reached = Promise.withResolvers<void>()
    let reads = 0
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        reads++
        if (hung === 'first-read') {
          reached.resolve()
          return new Promise(() => {})
        }
        return { goal: null }
      },
      'turn/interrupt': () => {
        if (hung === 'interrupt') {
          reached.resolve()
          return new Promise(() => {})
        }
        return {}
      }
    })
    const host = await openChat(child)
    child.notify('turn/started', { threadId: THREAD, turn: { id: 'running' } })
    await host.flushStreamedEvents(SESSION)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const pending = stop(host)
    await reached.promise
    await vi.advanceTimersByTimeAsync(1_667)
    expect(child.requests().some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(child.closes()).toBe(0)
    expect(reads).toBe(hung === 'first-read' ? 2 : 1)
    await vi.advanceTimersByTimeAsync(3_333)
    expect(await pending).toMatchObject({ ok: true })
    await settleStop(host)
    expect(child.closes()).toBe(1)
    expect(reads).toBe(hung === 'first-read' ? 2 : 1)
    expect(await rows(host)).toContain(
      hung === 'first-read' ? COPY.pauseUnconfirmed : COPY.stopUnconfirmed
    )
  }
)

it('treats an exact goals-disabled declaration as inapplicable without skipping close', async () => {
  const child = codexScriptedChild({
    'thread/goal/get': () => {
      throw new CodexAppServerRequestError('thread/goal/get', -32600, 'goals feature is disabled')
    }
  })
  const host = await openChat(child)
  expect(await stop(host)).toMatchObject({ ok: true })
  await settleStop(host)
  expect(child.closes()).toBe(1)
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toHaveLength(1)
  expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
})

it('orders Stop behind active-Set handler effects and closes the old child before a later goal', async () => {
  const reply = Promise.withResolvers<unknown>()
  const effects = Promise.withResolvers<void>()
  const reading = Promise.withResolvers<void>()
  let state: string | null = null
  let reads = 0
  let activations = 0
  const trace: string[] = []
  const child = codexScriptedChild({
    'thread/goal/set': (params) => {
      const status = String(params?.status)
      trace.push(status)
      if (status === 'active' && ++activations === 1) {
        return reply.promise
      }
      state = status
      if (status === 'active') {
        expect(child.closes()).toBe(1)
      }
      return { goal: { status } }
    },
    'thread/goal/get': async () => {
      trace.push('get')
      if (++reads === 1) {
        reading.resolve()
        // Both supported provider versions finish the earlier exclusive handler before this Get.
        await effects.promise
        state = 'active'
        child.notify('turn/started', { threadId: THREAD, turn: { id: 'continued' } })
      }
      return { goal: state === null ? null : { status: state } }
    },
    'turn/interrupt': () => {
      trace.push('interrupt')
      child.notify('turn/completed', {
        threadId: THREAD,
        turn: { id: 'continued', status: 'interrupted' }
      })
      return {}
    }
  })
  const host = await openChat(child)
  const first = goal(host, { kind: 'set', objective: 'Earlier goal' })
  await eventually(() => expect(activations).toBe(1))
  const stopping = stop(host)
  reply.resolve({ goal: { status: 'active' } })
  expect(await first).toMatchObject({ ok: true })
  await reading.promise
  const later = goal(host, { kind: 'set', objective: 'Later goal' })
  expect(trace).toEqual(['active', 'get'])
  effects.resolve()
  expect(await stopping).toMatchObject({ ok: true })
  expect(await later).toMatchObject({ ok: true })
  expect(trace).toEqual(['active', 'get', 'paused', 'interrupt', 'get', 'active'])
  expect(state).toBe('active')
  expect(child.closes()).toBe(1)
})

it('answers Stop before the shipped 15s phone budget while the owned 15,970ms close excludes later input', async () => {
  let state = 'active'
  const child = codexScriptedChild({
    'thread/goal/get': () => ({ goal: { status: state } }),
    'thread/goal/set': (params) => {
      state = String(params?.status)
      return { goal: { status: state } }
    },
    'turn/interrupt': () => ({})
  })
  const host = await openChat(child)
  child.notify('turn/started', { threadId: THREAD, turn: { id: 'running' } })
  await host.flushStreamedEvents(SESSION)
  const dispose = host.deps.adapter.disposeSession?.bind(host.deps.adapter)
  if (!dispose) {
    throw new Error('missing disposal')
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const started = Date.now()
  const captured = Promise.withResolvers<void>()
  const refreshed = Promise.withResolvers<void>()
  const reaped = Promise.withResolvers<void>()
  const capture = vi.fn(() => captured.promise)
  const refresh = vi.fn(() => refreshed.promise)
  const exit = Promise.withResolvers<void>()
  let rootExited = false,
    completedAt: number | undefined
  vi.spyOn(host.deps.adapter, 'disposeSession').mockImplementation(async (id, observe) => {
    await closeProviderProcess({
      child: { pid: 12345, kill: () => true, stdin: new PassThrough() },
      exitPromise: exit.promise,
      rootVerdict: () => (rootExited ? 'exited' : 'live'),
      supervised: true,
      policy: rootOnlyProviderClosePolicy(true),
      tree: {
        capture,
        refresh,
        reap: async () => {
          rootExited = true
          exit.resolve()
          await reaped.promise
          return 'exited'
        },
        treeVerdict: 'exited'
      },
      terminateTree: async () => {
        throw new Error('unexpected fallback')
      }
    })
    const result = await dispose(id, observe)
    completedAt = Date.now() - started
    return result
  })
  const request = { envelope: envelope(host, 'agentSession.cancel', {}) }
  expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
  expect(Date.now() - started).toBeLessThan(15_000) // Unchanged shipped phone cancel budget.
  expect(completedAt).toBeUndefined()
  expect(
    child
      .requests()
      .filter((r) => r.method.startsWith('thread/goal/') || r.method === 'turn/interrupt')
      .map((r) => r.method)
  ).toEqual(['thread/goal/get', 'thread/goal/set', 'turn/interrupt', 'thread/goal/get'])
  let laterFinished = false
  const later = goal(host, { kind: 'set', objective: 'After Stop' }).then((value) => {
    laterFinished = true
    return value
  })
  for (const [ms, phase, reached] of [
    [5000, undefined, capture],
    [990, captured, capture],
    [5500, undefined, refresh],
    [990, refreshed, refresh]
  ] as const) {
    await vi.advanceTimersByTimeAsync(ms)
    expect(reached).toHaveBeenCalledOnce()
    phase?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(laterFinished).toBe(false)
    expect(child.closes()).toBe(0)
  }
  expect(rootExited).toBe(true)
  await vi.advanceTimersByTimeAsync(3490)
  reaped.resolve()
  expect(await later).toMatchObject({ ok: true })
  expect(completedAt).toBe(15_970)
  expect(child.closes()).toBe(1)
  const calls = child.requests().length
  expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
  await settleStop(host)
  expect(child.requests()).toHaveLength(calls)
  expect(child.closes()).toBe(1)
  expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
})
