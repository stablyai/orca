import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import {
  canReuseGateReceipt,
  findGateReceipt
} from '../../orchestration/control-plane/gate-receipt-validity'
import { admitOutcome } from '../../orchestration/control-plane/outcome-identity'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import {
  requiredEvidenceKinds,
  type RouteEvidence
} from '../../orchestration/control-plane/route-certification-evidence'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import {
  routeKey,
  UNKNOWN,
  type RouteIdentity,
  type RouteRow
} from '../../orchestration/control-plane/route-registry-types'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { OrcaRuntimeService } from '../../orca-runtime'
import { driveRunPhaseLaunches } from './orchestration-phase-launch'
import { resolveRuntimeBuildIdentity } from '../../orchestration/control-plane/runtime-build-identity'

const HEAD = 'a1b2c3d4e5f6'
const BUILDER: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }
const REVIEWER: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }
const COORD_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function routeRow(identity: RouteIdentity, roles: ('builder' | 'reviewer')[]): RouteRow {
  return {
    identity,
    provider: 'p',
    harness: 'h',
    roles,
    taskCapabilities: [],
    sessionModes: ['fresh', 'retained'],
    reasoningModes: ['high'],
    contextLimitTokens: UNKNOWN,
    costClass: UNKNOWN,
    identityProof: 'exact',
    launcherSupported: true,
    hookSupported: true,
    readiness: {
      availability: 'available',
      authenticated: true,
      providerStatus: 'ok',
      quota: { state: 'ok', resetAt: UNKNOWN, remainingFraction: UNKNOWN }
    },
    constraints: [],
    notes: null
  }
}

function evidenceFor(
  identity: RouteIdentity,
  role: 'builder' | 'reviewer',
  sessionMode: 'fresh' | 'retained'
): RouteEvidence[] {
  return requiredEvidenceKinds(sessionMode).map((kind) => ({
    routeKey: routeKey(identity),
    kind,
    role,
    sessionMode,
    outcome: 'PASS' as const,
    observedAt: new Date().toISOString(),
    // Why resolved, not literal: worker-start now admits evidence only when it
    // carries THIS runtime build's identity — both the version AND the commit
    // it was built from — so hand-written values go stale immediately. HEAD
    // below stays the COMPLETED WORK's sha, which is a different concept.
    runtimeVersion: resolveRuntimeBuildIdentity().id,
    commitSha: resolveRuntimeBuildIdentity().commitSha ?? HEAD,
    detail: null
  }))
}

/** Correction 3 — the end-to-end proof that a validated completion actually
 *  STARTS the next phase through the real `orchestration.workerStart` handler,
 *  with no coordinator or human step in between. */
describe('automatic lifecycle autostart', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let prompts: { handle: string; text: string }[]

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    prompts = []
    runId = db.createRun({
      objective: 'Autostart',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORD_PANE : `tab_${handle}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle: string) => ({ handle, worktreeId: 'repo::wt', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::wt',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'createTerminal').mockImplementation(
      async () => ({ handle: 'term_reviewer', worktreeId: 'repo::wt' }) as never
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle: string) =>
        ({
          paneKey: `tab_${handle}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
          processIncarnation: `runtime_test:${handle}:1`,
          launchTokenHash: `hash_${handle}`,
          hostScope: { kind: 'local', hostId: 'local' }
        }) as never
    )
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(8)
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(
      async (handle: string) =>
        ({
          handle,
          condition: 'tui-idle',
          satisfied: true,
          status: 'running',
          exitCode: null
        }) as never
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, text) => {
      prompts.push({ handle, text })
      return { handle, accepted: true, bytesWritten: text.length } as never
    })
  })

  afterEach(() => db.close())

  function admit(reviewerCandidates: RouteIdentity[] = [REVIEWER]) {
    const store = new ControlPlaneStore(db)
    admitOutcome(store, { outcomeId: 'out_1', runId, title: 'Ship', fingerprint: 'f1' })
    new OutcomePolicyStore(db).put({
      outcomeId: 'out_1',
      taskClassification: 'bounded_implementation',
      builderCandidates: [BUILDER],
      reviewerCandidates,
      reviewCapabilities: [],
      allowUnknownQuota: false
    })
    const registry = new RouteRegistryStore(db)
    registry.upsertRoute(routeRow(BUILDER, ['builder']))
    registry.upsertRoute(routeRow(REVIEWER, ['reviewer']))
    for (const record of [
      ...evidenceFor(BUILDER, 'builder', 'retained'),
      ...evidenceFor(REVIEWER, 'reviewer', 'fresh')
    ]) {
      registry.recordRouteEvidence(record)
    }
  }

  function launchBuilder(taskId: string, identity: RouteIdentity, handle: string) {
    const started = db.createStartingWorkerDispatch({
      taskId,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: identity.agent,
        launch: {
          requested: { agent: identity.agent, model: identity.model, effort: identity.reasoning },
          effective: { agent: identity.agent, model: identity.model, effort: identity.reasoning }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: `tab_${handle}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      processIncarnation: `runtime_test:${handle}:1`,
      launchTokenHash: `hash_${handle}`,
      worktreeId: 'repo::wt',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return db.getDispatchContextById(started.dispatch.id)!
  }

  function report(args: {
    taskId: string
    dispatchId: string
    handle: string
    corrections?: string[]
    sha?: string
  }) {
    const sha = args.sha ?? HEAD
    return db.insertMessage({
      runId,
      from: args.handle,
      to: 'term_coord',
      subject: 'Done',
      type: 'worker_done',
      senderPaneKey: `tab_${args.handle}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      payload: JSON.stringify({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        outcome: 'succeeded',
        filesModified: ['src/a.ts'],
        ...(args.corrections ? { corrections: args.corrections } : {}),
        completion: {
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          outcomeId: 'out_1',
          headSha: sha,
          claimedSha: sha,
          worktreeClean: true,
          placement: 'local',
          receipt: {
            sha,
            result: 'PASS',
            policyVersion: 'gates-v1',
            commandIdentity: 'pnpm test'
          }
        }
      })
    })
  }

  async function drive() {
    await driveRunPhaseLaunches({ runtime, ctx: { runtime }, runId })
  }

  it('starts the independent fresh reviewer on the certified route, bound to the exact SHA', async () => {
    admit()
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    expect(
      reconcileLifecycleMessage(
        db,
        report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
      )
    ).toMatchObject({ action: 'completed' })

    const store = new PhaseLaunchStore(db)
    const planned = store.list(runId)
    expect(planned).toHaveLength(1)
    // Bug-rejecting: at this point the Task exists but nothing is running.
    expect(planned[0]).toMatchObject({ kind: 'review', state: 'pending', dispatch_id: null })

    await drive()
    const launched = store.list(runId)[0]
    expect(launched.state).toBe('started')
    expect(launched.dispatch_id).toBeTruthy()

    const reviewDispatch = db.getDispatchContextById(launched.dispatch_id as string)
    expect(reviewDispatch?.run_id).toBe(runId)
    expect(reviewDispatch?.task_id).toBe(launched.task_id)
    // A fresh independent session: not the builder's terminal.
    expect(reviewDispatch?.assignee_handle).not.toBe('term_builder')
    const reviewPrompt = prompts.at(-1)
    expect(reviewPrompt?.text).toContain(HEAD)
    expect(reviewPrompt?.text).toContain('do not review the branch tip')
    // The route came from the launch record, which came from the certified plan.
    const startOptions = JSON.parse(
      db.getWorkerDispatch(launched.dispatch_id as string)!.start_options
    )
    expect(startOptions.agent).toBe('codex')
    expect(startOptions.launch.effective.model).toBe('gpt-5.6-sol')
  })

  it('bug-rejecting: driving twice starts the reviewer exactly once', async () => {
    admit()
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
    )
    await drive()
    const first = new PhaseLaunchStore(db).list(runId)[0].dispatch_id
    const promptsAfterFirst = prompts.length
    await drive()
    await drive()
    expect(new PhaseLaunchStore(db).list(runId)).toHaveLength(1)
    expect(new PhaseLaunchStore(db).list(runId)[0].dispatch_id).toBe(first)
    expect(prompts).toHaveLength(promptsAfterFirst)
  })

  it('re-engages the original retained builder for FIX_FIRST with a delta, not a new session', async () => {
    admit()
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
    )
    await drive()
    const reviewLaunch = new PhaseLaunchStore(db).list(runId)[0]
    const reviewDispatch = db.getDispatchContextById(reviewLaunch.dispatch_id as string)!

    prompts.length = 0
    reconcileLifecycleMessage(
      db,
      report({
        taskId: reviewLaunch.task_id,
        dispatchId: reviewDispatch.id,
        handle: reviewDispatch.assignee_handle as string,
        corrections: ['tighten the guard']
      })
    )
    await drive()

    const launches = new PhaseLaunchStore(db).list(runId)
    const fix = launches.find((row) => row.kind === 'fix_first')
    expect(fix).toMatchObject({ state: 'started', terminal_handle: 'term_builder' })
    const fixDispatch = db.getDispatchContextById(fix?.dispatch_id as string)
    // Same session, new Dispatch for the correction Task — never a second builder.
    expect(fixDispatch?.assignee_handle).toBe('term_builder')
    expect(fixDispatch?.id).not.toBe(builder.id)
    const delta = prompts.find((prompt) => prompt.handle === 'term_builder')
    expect(delta?.text).toContain('=== NEW DISPATCH ===')
    expect(delta?.text).toContain('tighten the guard')
    expect(delta?.text).not.toContain('=== CLI COMMANDS ===')
  })

  it('bug-rejecting: FIX_FIRST reaches the original builder exactly once across replays', async () => {
    admit()
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
    )
    await drive()
    const reviewLaunch = new PhaseLaunchStore(db).list(runId)[0]
    const reviewDispatch = db.getDispatchContextById(reviewLaunch.dispatch_id as string)!
    prompts.length = 0
    for (let replay = 0; replay < 3; replay += 1) {
      reconcileLifecycleMessage(
        db,
        report({
          taskId: reviewLaunch.task_id,
          dispatchId: reviewDispatch.id,
          handle: reviewDispatch.assignee_handle as string,
          corrections: ['tighten the guard']
        })
      )
      await drive()
    }
    expect(
      new PhaseLaunchStore(db).list(runId).filter((row) => row.kind === 'fix_first')
    ).toHaveLength(1)
    expect(prompts.filter((prompt) => prompt.handle === 'term_builder')).toHaveLength(1)
  })

  it('after a corrected completion, reruns invalidated gates and auto-starts review on the new SHA', async () => {
    admit()
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
    )
    await drive()
    const firstReview = new PhaseLaunchStore(db).list(runId)[0]
    const reviewDispatch = db.getDispatchContextById(firstReview.dispatch_id as string)!
    reconcileLifecycleMessage(
      db,
      report({
        taskId: firstReview.task_id,
        dispatchId: reviewDispatch.id,
        handle: reviewDispatch.assignee_handle as string,
        corrections: ['tighten the guard']
      })
    )
    await drive()
    const fix = new PhaseLaunchStore(db).list(runId).find((row) => row.kind === 'fix_first')!
    const fixDispatch = db.getDispatchContextById(fix.dispatch_id as string)!

    // The correction lands on a NEW commit. A content gate survives that when
    // nothing it depends on changed, and dies the moment its inputs move — the
    // SHA alone is not what invalidates it.
    const CORRECTED = 'bbbbbbbbbbbb'
    const beforeCorrection = findGateReceipt(store, `${runId}:out_1`, 'pnpm test')
    const contentGate = {
      gateId: 'pnpm test',
      finalSha: CORRECTED,
      inputHashes: beforeCorrection?.inputHashes ?? {},
      policyVersion: 'gates-v1',
      commandIdentity: 'pnpm test'
    }
    expect(canReuseGateReceipt({ receipt: beforeCorrection, current: contentGate })).toMatchObject({
      reuse: true
    })
    expect(
      canReuseGateReceipt({
        receipt: beforeCorrection,
        current: { ...contentGate, inputHashes: { 'file:src/a.ts': 'changed-by-the-correction' } }
      })
    ).toMatchObject({ reuse: false, code: 'inputs_changed' })
    // An exact-head gate still dies with the SHA, whatever its inputs look like.
    expect(
      canReuseGateReceipt({
        receipt: beforeCorrection,
        current: { ...contentGate, shaBinding: 'exact_head' }
      })
    ).toMatchObject({ reuse: false, code: 'sha_changed' })

    prompts.length = 0
    reconcileLifecycleMessage(
      db,
      report({
        taskId: fix.task_id,
        dispatchId: fixDispatch.id,
        handle: 'term_builder',
        sha: CORRECTED
      })
    )
    await drive()

    const reviews = new PhaseLaunchStore(db).list(runId).filter((row) => row.kind === 'review')
    expect(reviews).toHaveLength(2)
    const secondReview = reviews[1]
    // The new review is bound to the CORRECTED commit and actually started.
    expect(secondReview).toMatchObject({ state: 'started', bound_sha: CORRECTED })
    expect(secondReview.dispatch_id).toBeTruthy()
    expect(prompts.at(-1)?.text).toContain(CORRECTED)
    // The gate receipt now proves the corrected SHA, so it is reusable again.
    expect(findGateReceipt(store, `${runId}:out_1`, 'pnpm test')?.finalSha).toBe(CORRECTED)
  })

  it('emits the protected blocker instead of starting an uncertified reviewer', async () => {
    admit([])
    const task = db.createTask({ spec: 'build it', runId })
    const builder = launchBuilder(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({ taskId: task.id, dispatchId: builder.id, handle: 'term_builder' })
    )
    await drive()
    expect(new PhaseLaunchStore(db).list(runId)).toEqual([])
    const blocker = db
      .getRunMailboxHistory(runId, 20, ['escalation'])
      .find((message) => message.subject.startsWith('Protected blocker'))
    expect(blocker).toBeTruthy()
    // Nothing was launched on any substitute route.
    expect(prompts).toHaveLength(0)
  })
})
