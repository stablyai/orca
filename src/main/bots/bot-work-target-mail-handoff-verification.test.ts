import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { ORCHESTRATION_UNBOUND_RUN_ID } from '../../shared/orchestration/orchestration-rpc-contract'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  markUnreadFollowUpMail,
  resolveWorkerLineage
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationStructuredMailboxPointerDelivery } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import {
  continueUnreadWorkerMailNow,
  passHeldWorkerMail
} from '../runtime/rpc/methods/orchestration/messaging/settled-worker-follow-through'
import { startWorker } from '../runtime/rpc/methods/orchestration/worker/worker-start-method'
import { createStructuredMailWorkTargetVerifier } from './bot-work-target-structured-mail-gate'
import {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  createFollowUpHostFixture,
  makeExplicitWorkspaceTarget,
  makeProjectTarget,
  rpcReq,
  seedLocalWorker,
  teardownFollowUpTestFixtures
} from './bot-work-target-follow-up.test-fixture'

const structuredHostRef: { current: unknown } = { current: null }

vi.mock(
  '../native-chat/agent-session-wire/host/structured-agent-session-registry',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StructuredRegistry>()
    return { ...actual, getStructuredAgentSessionHost: () => structuredHostRef.current }
  }
)

const tempDirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => teardownFollowUpTestFixtures(structuredHostRef, dbs, tempDirs))

type CheckResponse = {
  ok: true
  result: {
    count: number
    messages: { id: string; subject: string; body: string; payload?: string | null }[]
    deliveryId?: string
  }
}

function isCheckResponse(value: unknown): value is CheckResponse {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) {
    return false
  }
  if (!('result' in value) || !value.result || typeof value.result !== 'object') {
    return false
  }
  const { result } = value
  return (
    'count' in result &&
    typeof result.count === 'number' &&
    'messages' in result &&
    Array.isArray(result.messages)
  )
}

function expectCheckOk(response: unknown): CheckResponse['result'] {
  expect(response).toMatchObject({ ok: true })
  if (!isCheckResponse(response)) {
    throw new Error('Expected orchestration.check ok response')
  }
  return response.result
}

function stubLiveLocalPtyEdge(
  fx: Awaited<ReturnType<typeof createFollowUpHostFixture>>,
  terminals: Record<string, { paneKey: string; incarnation: string; worktreeId: string }>
) {
  const byPane = new Map(Object.entries(terminals).map(([handle, info]) => [info.paneKey, handle]))
  vi.spyOn(fx.runtime, 'getTerminalHandleForPaneKey').mockImplementation(
    (paneKey) => byPane.get(paneKey) ?? null
  )
  vi.spyOn(fx.runtime, 'getTerminalProcessIncarnation').mockImplementation(
    (handle) => terminals[handle]?.incarnation ?? null
  )
  vi.spyOn(fx.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
    const info = terminals[handle]
    if (!info) {
      return null
    }
    return {
      runtimeId: fx.runtime.getRuntimeId(),
      terminalHandle: handle,
      ptyId: `pty_${handle}`,
      worktreeId: info.worktreeId,
      paneKey: info.paneKey,
      processIncarnation: info.incarnation,
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    }
  })
  vi.spyOn(fx.runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
    handle,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  }))
  vi.spyOn(fx.runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle) => ({
    handle,
    accepted: true,
    bytesWritten: 16,
    prompt: {
      requestId: 'req_test',
      stages: ['input_accepted', 'turn_started'],
      provider: 'codex',
      observation: 'supported',
      processIncarnation: terminals[handle]?.incarnation ?? 'inc-test',
      generation: 1,
      baselineWorkingSequence: 0
    }
  }))
}

describe('work-target mail handoff, read/peek/delivery gates, mixed follow-through, and coordinator direct mail', () => {
  it('holds targeted takesMailOf mail out of pending Dispatch until workspace verification succeeds, and refuses safely on mid-verification registration swap', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'start-exposure-order'
    })
    const paneAcme = 'tab_acme:11111111-1111-4111-8111-111111111111'
    stubLiveLocalPtyEdge(fx, {
      term_acme: { paneKey: paneAcme, incarnation: 'inc-acme-1', worktreeId: 'wt-acme' }
    })

    const run = fx.db.createRun({
      objective: 'Start exposure order',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const w1 = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Settled acme worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: paneAcme,
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1',
      settled: true
    })
    const explicitTarget = makeExplicitWorkspaceTarget()
    const targetedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${w1.dispatchId}`,
      subject: 'Targeted start mail',
      body: 'Secret targeted payload',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    markUnreadFollowUpMail(fx.db, w1.dispatchId)

    // Pause workspace re-verification right inside verifyAndBindTakesMailForHandOver (once pending follow-up Dispatch exists).
    const origShowWorkspace = vi
      .mocked(fx.runtime.showManagedTerminalWorkspace)
      .getMockImplementation()!
    let enteredHandOverVerify!: () => void
    const handOverVerifyEntered = new Promise<void>((resolve) => {
      enteredHandOverVerify = resolve
    })
    let releaseHandOverVerify!: () => void
    const handOverVerifyGate = new Promise<void>((resolve) => {
      releaseHandOverVerify = resolve
    })
    vi.spyOn(fx.runtime, 'showManagedTerminalWorkspace').mockImplementation(
      async (selector, requiredHostId) => {
        const pendingChild = fx.db.db
          .prepare('SELECT id FROM dispatch_contexts WHERE follow_up_of_dispatch_id = ?')
          .get(w1.dispatchId)
        if (requiredHostId === 'local' && pendingChild) {
          enteredHandOverVerify()
          await handOverVerifyGate
        }
        return origShowWorkspace(selector, requiredHostId)
      }
    )

    const botCaller = {
      address: BOT_ADDRESS,
      terminalHandle: null,
      paneKey: null,
      orcaSessionId: BOT_SESSION_ID,
      sessionId: BOT_SESSION_ID,
      workspaceId: folderWorkspaceKey(fx.botHomeFolder.id)
    }
    const startPromise = startWorker(
      { from: BOT_ADDRESS, run: run.id, spec: 'Continue targeted mail' },
      { runtime: fx.runtime, orchestrationCaller: botCaller },
      {
        of: w1.dispatchId,
        addressed: w1.dispatchId,
        takesMailOf: w1.dispatchId,
        trustedUnreadMailFollowThrough: true,
        place: async () => ({
          delivery: 'follow_up',
          worktreeId: 'wt-acme',
          terminal: 'term_acme'
        })
      }
    )

    await handOverVerifyEntered

    // While verification is in flight, pending Dispatch exists in DB, is NOT yet bound, and targeted mail is NOT readable via RPC!
    expect(
      fx.db.db
        .prepare('SELECT id, status FROM dispatch_contexts WHERE follow_up_of_dispatch_id = ?')
        .get(w1.dispatchId)
    ).toMatchObject({ status: 'pending' })
    expect(fx.db.getActiveDispatchForIdentity('term_acme', paneAcme)).toBeUndefined()
    expect(fx.db.getUnreadMessages(`dispatch:${w1.dispatchId}`).map((m) => m.id)).toEqual([
      targetedMsg.id
    ])
    const midPeek = expectCheckOk(
      await fx.dispatcher.dispatch(
        rpcReq('orchestration.check', { terminal: 'term_acme', peek: true })
      )
    )
    expect(midPeek.messages.some((m) => m.id === targetedMsg.id)).toBe(false)
    const midCheck = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(midCheck.messages.some((m) => m.id === targetedMsg.id)).toBe(false)

    // Hide/replace registered repo mid-verification: synchronous commit recheck must refuse & hold original safely.
    fx.store.updateRepo({ id: 'repo-acme' }, { hiddenAt: 1_700_000_000_000 })
    releaseHandOverVerify()
    expect(await startPromise).toMatchObject({ state: 'failed' })
    expect(fx.db.getActiveDispatchForIdentity('term_acme', paneAcme)).toBeUndefined()
    expect(fx.db.getMessageById(targetedMsg.id)?.to_handle).toBe(`dispatch:${w1.dispatchId}`)
    expect(fx.db.getMessageById(targetedMsg.id)?.read).toBe(0)
    expect(fx.db.getDispatchContextById(w1.dispatchId)?.follow_up_mail_at).not.toBeNull()
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)

    // Restore valid registration and start a verified follow-up: targeted mail hands over and is readable via RPC check.
    fx.store.updateRepo({ id: 'repo-acme' }, { hiddenAt: null })
    vi.spyOn(fx.runtime, 'showManagedTerminalWorkspace').mockImplementation(origShowWorkspace)
    const w2Base = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Second settled acme worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: paneAcme,
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1',
      settled: true
    })
    const validTargeted = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${w2Base.dispatchId}`,
      subject: 'Valid targeted follow-up',
      body: 'Deliver once verified',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    markUnreadFollowUpMail(fx.db, w2Base.dispatchId)
    const okStart = await startWorker(
      { from: BOT_ADDRESS, run: run.id, spec: 'Continue valid targeted mail' },
      { runtime: fx.runtime, orchestrationCaller: botCaller },
      {
        of: w2Base.dispatchId,
        addressed: w2Base.dispatchId,
        takesMailOf: w2Base.dispatchId,
        trustedUnreadMailFollowThrough: true,
        place: async () => ({
          delivery: 'follow_up',
          worktreeId: 'wt-acme',
          terminal: 'term_acme'
        })
      }
    )
    expect(okStart).toMatchObject({ state: 'ready' })
    expect(fx.db.getUnreadMessages(`dispatch:${w2Base.dispatchId}`)).toHaveLength(0)

    const workerRead = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(workerRead.messages.map((m) => m.id)).toEqual([validTargeted.id])
    expect(fx.db.getMessageById(validTargeted.id)?.read).toBe(1)
  })

  it('enforces target verification across read, peek, --all, pre-existing outstanding delivery batches, and mid-reconciliation registration swaps', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'read-peek-delivery-gates'
    })
    const paneAcme = 'tab_acme:11111111-1111-4111-8111-111111111111'
    stubLiveLocalPtyEdge(fx, {
      term_acme: { paneKey: paneAcme, incarnation: 'inc-acme-1', worktreeId: 'wt-acme' }
    })

    const run = fx.db.createRun({
      objective: 'Read and delivery verification',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const active = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Active worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: paneAcme,
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1'
    })
    const explicitTarget = makeExplicitWorkspaceTarget()
    const ordinaryMsg = fx.db.insertMessage({
      from: 'term_human',
      to: `dispatch:${active.dispatchId}`,
      subject: 'Ordinary update',
      body: 'Plain info',
      type: 'status',
      runId: run.id
    })
    const targetedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${active.dispatchId}`,
      subject: 'Drifted targeted work',
      body: 'Must stay held on drift',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })

    // Pre-create an existing `outstanding` delivery batch containing BOTH ordinary + targeted mail before drift!
    const dispatchRow = fx.db.getDispatchContextById(active.dispatchId)!
    const existingBatch = fx.db.getOrCreateMailboxDelivery({
      runId: run.id,
      mailboxHandle: `dispatch:${active.dispatchId}`,
      consumerGeneration: dispatchRow.consumer_generation
    })
    expect(existingBatch?.messages.map((m) => m.id)).toEqual([ordinaryMsg.id, targetedMsg.id])

    // Drift checkout incarnation: peek, --all, and consuming read must hide/hold targetedMsg while delivering ordinaryMsg.
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'

    const peekRes = expectCheckOk(
      await fx.dispatcher.dispatch(
        rpcReq('orchestration.check', { terminal: 'term_acme', peek: true })
      )
    )
    expect(peekRes.messages.map((m) => m.id)).toEqual([ordinaryMsg.id])

    const allRes = expectCheckOk(
      await fx.dispatcher.dispatch(
        rpcReq('orchestration.check', { terminal: 'term_acme', all: true })
      )
    )
    expect(allRes.messages.map((m) => m.id)).toEqual([ordinaryMsg.id])

    const readRes = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(readRes.messages.map((m) => m.id)).toEqual([ordinaryMsg.id])
    expect(fx.db.getMessageById(ordinaryMsg.id)?.read).toBe(1)
    expect(fx.db.getMessageById(targetedMsg.id)?.read).toBe(0)
    expect(fx.db.getDeliveryRaw(existingBatch!.delivery.id)?.status).toBe('fenced')
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)

    // Calling check again when ONLY the held targeted message remains returns 0 messages and ZERO duplicate hold notices.
    const secondRead = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(secondRead.count).toBe(0)
    expect(fx.db.getMessageById(targetedMsg.id)?.read).toBe(0)
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)

    // Mid-reconciliation registration swap: restore valid incarnation, then remove repo registration inside commit verification!
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'
    const origShow = vi.mocked(fx.runtime.showManagedTerminalWorkspace).getMockImplementation()!
    let verifyCalls = 0
    vi.spyOn(fx.runtime, 'showManagedTerminalWorkspace').mockImplementation(
      async (selector, requiredHostId) => {
        const res = await origShow(selector, requiredHostId)
        verifyCalls += 1
        // 1st call is pre-claim gate (passes); 2nd call is reconcile commit-verifier (mutates catalog right before reverifySync).
        if (verifyCalls === 2) {
          fx.store.updateRepo({ id: 'repo-acme' }, { hiddenAt: 1_700_000_000_000 })
        }
        return res
      }
    )
    const swapRead = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(verifyCalls).toBe(2)
    expect(swapRead.count).toBe(0)
    expect(fx.db.getMessageById(targetedMsg.id)?.read).toBe(0)
    expect(fx.db.getOutstandingMailboxDelivery(`dispatch:${active.dispatchId}`)).toBeUndefined()
  })

  it('continues ordinary and valid targeted mail on a settled worker with no successor while holding invalid targeted mail without duplicates', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'mixed-follow-through-e2e'
    })
    const paneAcme = 'tab_acme:11111111-1111-4111-8111-111111111111'
    stubLiveLocalPtyEdge(fx, {
      term_acme: { paneKey: paneAcme, incarnation: 'inc-acme-1', worktreeId: 'wt-acme' }
    })

    const run = fx.db.createRun({
      objective: 'Mixed follow-through E2E',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const explicitTarget = makeExplicitWorkspaceTarget()

    // Case A: Settled worker with no successor has [ordinary, driftedTargeted, corruptTargeted].
    const wMixed = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Settled worker A',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: paneAcme,
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1',
      settled: true
    })
    const ordinaryMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wMixed.dispatchId}`,
      subject: 'Ordinary follow-up',
      body: 'Continue ordinary work',
      type: 'status',
      runId: run.id
    })
    const driftedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wMixed.dispatchId}`,
      subject: 'Drifted targeted work',
      body: 'Do not deliver to inst-acme-2',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    const corruptMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wMixed.dispatchId}`,
      subject: 'Corrupt targeted work',
      body: 'Broken provenance',
      type: 'status',
      runId: run.id
    })
    fx.db.db
      .prepare(
        'INSERT INTO message_work_target_provenance (message_id, source_origin, placement_json) VALUES (?, ?, ?)'
      )
      .run(corruptMsg.id, `session:${BOT_SESSION_ID}`, '{invalid-json')
    markUnreadFollowUpMail(fx.db, wMixed.dispatchId)

    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'
    await continueUnreadWorkerMailNow(fx.runtime, fx.db, wMixed.dispatchId)

    const successorA = resolveWorkerLineage(fx.db, wMixed.dispatchId)?.latest
    expect(successorA && successorA.id !== wMixed.dispatchId).toBe(true)
    const readA = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(readA.messages.map((m) => m.id)).toEqual([ordinaryMsg.id])
    expect(fx.db.getMessageById(ordinaryMsg.id)?.read).toBe(1)
    expect(fx.db.getUnreadMessages(`dispatch:${wMixed.dispatchId}`).map((m) => m.id)).toEqual([
      driftedMsg.id,
      corruptMsg.id
    ])
    expect(fx.db.getDispatchContextById(wMixed.dispatchId)?.follow_up_mail_at).not.toBeNull()

    // Repeating follow-through and passHeldWorkerMail must NOT duplicate work or hold notices.
    await continueUnreadWorkerMailNow(fx.runtime, fx.db, wMixed.dispatchId)
    await passHeldWorkerMail(fx.runtime, fx.db, successorA!.id)
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter(
          (m) =>
            m.from_handle === `dispatch:${wMixed.dispatchId}` &&
            m.payload?.includes('work_target_mail_held')
        )
    ).toHaveLength(1)

    // Case B: Settled worker with [validTargeted, mismatchedTargeted] consumes validTargeted cleanly without duplicating work or notices.
    fx.db.completeDispatch(successorA!.id)
    fx.db.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(successorA!.id)
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'

    const wValidMixed = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Settled worker B',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: paneAcme,
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1',
      settled: true
    })
    const validTargeted = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wValidMixed.dispatchId}`,
      subject: 'Valid targeted task',
      body: 'Run acme tests',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    const mismatchedTargeted = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wValidMixed.dispatchId}`,
      subject: 'Mismatched targeted task',
      body: 'Wrong project',
      type: 'status',
      runId: run.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: makeProjectTarget({
          repoSelector: 'id:repo-other',
          canonicalTarget: {
            kind: 'project',
            hostId: 'local',
            repoId: 'repo-other',
            repoKind: 'git',
            displayName: 'other-project'
          }
        })
      }
    })
    markUnreadFollowUpMail(fx.db, wValidMixed.dispatchId)
    await continueUnreadWorkerMailNow(fx.runtime, fx.db, wValidMixed.dispatchId)

    const successorB = resolveWorkerLineage(fx.db, wValidMixed.dispatchId)?.latest
    expect(successorB && successorB.id !== wValidMixed.dispatchId).toBe(true)
    const readB = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(readB.messages.map((m) => m.id)).toEqual([validTargeted.id])
    expect(fx.db.getMessageById(validTargeted.id)?.read).toBe(1)
    expect(fx.db.getUnreadMessages(`dispatch:${wValidMixed.dispatchId}`).map((m) => m.id)).toEqual([
      mismatchedTargeted.id
    ])
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter(
          (m) =>
            m.from_handle === `dispatch:${wValidMixed.dispatchId}` &&
            m.payload?.includes('work_target_mail_held')
        )
    ).toHaveLength(1)
  })

  it('delivers queued targeted direct mail when a matching recipient becomes Run coordinator and holds + notifies on mismatch', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'coordinator-direct-mail'
    })
    const paneAcme = 'tab_acme:11111111-1111-4111-8111-111111111111'
    const paneOther = 'tab_other:22222222-2222-4222-8222-222222222222'
    stubLiveLocalPtyEdge(fx, {
      term_acme: { paneKey: paneAcme, incarnation: 'inc-acme-1', worktreeId: 'wt-acme' },
      term_other: { paneKey: paneOther, incarnation: 'inc-other-1', worktreeId: 'wt-other' }
    })

    // 1) Matching coordinator: targeted direct mail queued BEFORE bindRun (both run-scoped and run_unbound) must be visible & consumable.
    const runMatch = fx.db.createRun({
      objective: 'Matching coordinator handover',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const acmeProjectTarget = makeProjectTarget()
    const runScopedDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_acme',
      subject: 'Queued run-scoped targeted direct',
      body: 'Review acme PR',
      type: 'status',
      runId: runMatch.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: acmeProjectTarget
      }
    })
    const unboundDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_acme',
      subject: 'Queued unbound targeted direct',
      body: 'Standalone acme task',
      type: 'status',
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: acmeProjectTarget
      }
    })
    expect(unboundDirect.run_id).toBe(ORCHESTRATION_UNBOUND_RUN_ID)
    const ordinaryDirect = fx.db.insertMessage({
      from: 'term_human',
      to: 'term_acme',
      subject: 'Ordinary coordinator note',
      body: 'Hello coordinator',
      type: 'status',
      runId: runMatch.id
    })

    // Recipient terminal becomes Run coordinator via bindRun: ordinary routes immediately; targeted stays until verified.
    fx.db.bindRun({
      runId: runMatch.id,
      coordinatorHandle: 'term_acme',
      coordinatorPaneKey: paneAcme
    })
    expect(fx.db.getMessageById(ordinaryDirect.id)?.to_handle).toBe(`run:${runMatch.id}`)
    expect(fx.db.getMessageById(runScopedDirect.id)?.to_handle).toBe('term_acme')

    const peekCoord = expectCheckOk(
      await fx.dispatcher.dispatch(
        rpcReq('orchestration.check', { terminal: 'term_acme', peek: true })
      )
    )
    expect(peekCoord.messages.map((m) => m.id)).toEqual([runScopedDirect.id, ordinaryDirect.id])

    const readCoord = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_acme' }))
    )
    expect(readCoord.messages.map((m) => m.id)).toEqual([
      runScopedDirect.id,
      unboundDirect.id,
      ordinaryDirect.id
    ])
    expect(fx.db.getMessageById(runScopedDirect.id)?.read).toBe(1)
    expect(fx.db.getMessageById(unboundDirect.id)?.read).toBe(1)

    // 2) Mismatched coordinator (term_other on repo-other): targeted acme direct mail stays held unread + 1 hold notice on run:<id>.
    const runMismatch = fx.db.createRun({
      objective: 'Mismatched coordinator handover',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const mismatchRunDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_other',
      subject: 'Wrong-target run direct',
      body: 'Acme secret must not leak to other-project',
      type: 'status',
      runId: runMismatch.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: acmeProjectTarget
      }
    })
    const mismatchUnboundDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_other',
      subject: 'Wrong-target unbound direct',
      body: 'Unbound acme secret',
      type: 'status',
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: acmeProjectTarget
      }
    })
    expect(mismatchUnboundDirect.run_id).toBe(ORCHESTRATION_UNBOUND_RUN_ID)
    const otherOrdinary = fx.db.insertMessage({
      from: 'term_human',
      to: 'term_other',
      subject: 'Ordinary other coordinator mail',
      body: 'Normal coordinator update',
      type: 'status',
      runId: runMismatch.id
    })
    fx.db.bindRun({
      runId: runMismatch.id,
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: paneOther
    })

    const mismatchRead = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_other' }))
    )
    expect(mismatchRead.messages.some((m) => m.id === mismatchRunDirect.id)).toBe(false)
    expect(mismatchRead.messages.some((m) => m.id === mismatchUnboundDirect.id)).toBe(false)
    expect(mismatchRead.messages.some((m) => m.id === otherOrdinary.id)).toBe(true)
    expect(
      mismatchRead.messages.filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)
    expect(fx.db.getMessageById(mismatchRunDirect.id)?.read).toBe(0)
    expect(fx.db.getMessageById(mismatchRunDirect.id)?.to_handle).toBe('term_other')
    expect(fx.db.getMessageById(mismatchUnboundDirect.id)?.read).toBe(0)
    expect(fx.db.getMessageById(mismatchUnboundDirect.id)?.to_handle).toBe('term_other')

    // Drain hold notice created by withOwnDirectMail for mismatchUnboundDirect, then confirm repeated check produces zero extra notices.
    const drainNotice = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_other' }))
    )
    expect(
      drainNotice.messages.filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)
    const repeatCheck = expectCheckOk(
      await fx.dispatcher.dispatch(rpcReq('orchestration.check', { terminal: 'term_other' }))
    )
    expect(repeatCheck.count).toBe(0)
  })

  it('gates whole-mail structured chat push delivery against work-target drift while letting ordinary mail through', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'structured-chat-push-gate'
    })
    const run = fx.db.createRun({
      objective: 'Structured push target gate',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const worker = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Structured worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-chat-1',
      worktreeInstanceId: 'inst-acme-1'
    })
    const explicitTarget = makeExplicitWorkspaceTarget()
    const targetedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${worker.dispatchId}`,
      subject: 'Chat targeted task',
      body: 'Secret chat payload',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    const ordinaryMsg = fx.db.insertMessage({
      from: 'term_human',
      to: `dispatch:${worker.dispatchId}`,
      subject: 'Chat ordinary note',
      body: 'Visible ordinary note',
      type: 'status',
      runId: run.id
    })

    const sentBodies: string[] = []
    const mockHost: StructuredMailboxPointerHost = {
      currentFence: () => 1,
      watchJournal: () => () => undefined,
      wakeQueue: () => undefined,
      observe: async () => ({ kind: 'accepted' }),
      withdraw: async () => ({ kind: 'unknown' }),
      send: async (args) => {
        if (!args.stillOwed()) {
          return { kind: 'obsolete' }
        }
        sentBodies.push(JSON.stringify(args.body))
        return { kind: 'sent', state: 'accepted' }
      }
    }
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => fx.db,
      getCliCommand: () => 'orca',
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (handle) =>
        handle === `dispatch:${worker.dispatchId}`
          ? { sessionId: BOT_SESSION_ID, dispatchId: worker.dispatchId }
          : null,
      senderSnapshot: () => ({ name: null, agent: null }),
      host: mockHost,
      verifyMessage: createStructuredMailWorkTargetVerifier(fx.runtime)
    })

    // Drift checkout before push delivery: ordinaryMsg pushes, targetedMsg stays unread + 1 hold notice.
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'
    delivery.deliverForHandle(`dispatch:${worker.dispatchId}`)
    await vi.waitFor(() => {
      expect(sentBodies.some((body) => body.includes('Visible ordinary note'))).toBe(true)
    })
    expect(sentBodies.some((body) => body.includes('Secret chat payload'))).toBe(false)
    expect(fx.db.getMessageById(targetedMsg.id)?.read).toBe(0)
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.payload?.includes('work_target_mail_held'))
    ).toHaveLength(1)

    // Restore valid checkout: targetedMsg now delivers cleanly!
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'
    delivery.deliverForHandle(`dispatch:${worker.dispatchId}`)
    await vi.waitFor(() => {
      expect(sentBodies.some((body) => body.includes('Secret chat payload'))).toBe(true)
    })
    expect(ordinaryMsg.id).toBeTruthy()
  })
})
