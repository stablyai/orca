import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readMessageWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import {
  markUnreadFollowUpMail,
  resolveWorkerLineage
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { continueUnreadWorkerMailNow } from '../runtime/rpc/methods/orchestration/messaging/settled-worker-follow-through'
import { startWorker } from '../runtime/rpc/methods/orchestration/worker/worker-start-method'
import {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  createFollowUpHostFixture,
  expectRpcFailure,
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

describe('local existing-worker follow-up and unread-mail provenance enforcement', () => {
  it('enforces explicit workspace incarnation, project registration/policy, and zero-effect refusals on local active & settled orchestration.send', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'local-send'
    })
    const run = fx.db.createRun({
      objective: 'Test work target follow-up',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const wAcme = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Work on acme',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme',
      worktreeInstanceId: 'inst-acme-1'
    })
    const wOther = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Work on other',
      worktreeId: 'wt-other',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-other',
      worktreeInstanceId: 'inst-other-1'
    })
    const wNoIncarnation = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Legacy worker without recorded instanceId',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_legacy_acme',
      paneKey: 'tab_legacy:33333333-3333-4333-8333-333333333333',
      processIncarnation: 'inc-legacy',
      worktreeInstanceId: null
    })
    const wSettledOther = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Settled worker in other project',
      worktreeId: 'wt-other',
      terminalHandle: 'term_settled_other',
      paneKey: 'tab_settled_other:44444444-4444-4444-8444-444444444444',
      processIncarnation: 'inc-settled-other',
      worktreeInstanceId: 'inst-other-1',
      settled: true
    })

    const explicitTarget = makeExplicitWorkspaceTarget()
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, explicitTarget)

    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wOther.dispatchId}`, subject: 'Follow up', body: 'Wrong workspace' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wOther.dispatchId}`)).toHaveLength(0)

    const matchResp = await fx.dispatcher.dispatch(
      rpcReq(
        'orchestration.send',
        { to: `dispatch:${wAcme.dispatchId}`, subject: 'Follow up', body: 'Continue auth fix' },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(matchResp.ok).toBe(true)
    const acmeUnread = fx.db.getUnreadMessages(`dispatch:${wAcme.dispatchId}`)
    expect(acmeUnread).toHaveLength(1)
    expect(readMessageWorkTargetProvenance(fx.db, acmeUnread[0]!.id)).toEqual({
      kind: 'valid',
      sourceOrigin: `session:${BOT_SESSION_ID}`,
      placement: explicitTarget
    })

    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wNoIncarnation.dispatchId}`, subject: 'Missing inc', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wNoIncarnation.dispatchId}`)).toHaveLength(0)

    // Delete & recreate AFTER selection (live inst-acme-2 !== expected inst-acme-1).
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wAcme.dispatchId}`, subject: 'After recreate', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wAcme.dispatchId}`)).toHaveLength(1)

    // Delete & recreate BEFORE selection (user selects inst-acme-2, worker ran under inst-acme-1).
    fx.runtime.botWorkTargets.setForTurn(
      BOT_SESSION_ID,
      makeExplicitWorkspaceTarget({
        worktreeSelector: 'identity:wt2:local:inst-acme-2',
        expectedWorkspaceInstanceId: 'inst-acme-2',
        canonicalTarget: { ...explicitTarget.canonicalTarget, workspaceInstanceId: 'inst-acme-2' }
      })
    )
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wAcme.dispatchId}`, subject: 'Old worker', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wAcme.dispatchId}`)).toHaveLength(1)

    // Restore incarnation; verify archived workspace and hidden repo refuse with zero side effects.
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, explicitTarget)
    fx.worktrees.get('wt-acme')!.isArchived = true
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wAcme.dispatchId}`, subject: 'Archived', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    fx.worktrees.get('wt-acme')!.isArchived = false
    fx.store.updateRepo({ id: 'repo-acme' }, { hiddenAt: 1_700_000_000_000 })
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wAcme.dispatchId}`, subject: 'Hidden repo', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    fx.store.updateRepo({ id: 'repo-acme' }, { hiddenAt: null })

    // Git project target: matching repo succeeds; swapped projectId setup, settled other-project
    // worker, and SSH Git project execution policy all refuse cleanly.
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, makeProjectTarget())
    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            { to: `dispatch:${wAcme.dispatchId}`, subject: 'Project follow-up', body: 'OK' },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    fx.setups[0]!.repoId = 'repo-other'
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wAcme.dispatchId}`, subject: 'Swapped setup', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    fx.setups[0]!.repoId = 'repo-acme'

    const requestReleaseSpy = vi.spyOn(fx.db, 'requestWorkerTerminalRelease')
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wSettledOther.dispatchId}`, subject: 'Settled wrong', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(requestReleaseSpy).not.toHaveBeenCalled()
    expect(resolveWorkerLineage(fx.db, wSettledOther.dispatchId)?.latest.id).toBe(
      wSettledOther.dispatchId
    )

    const wSsh = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'SSH worker',
      worktreeId: 'wt-ssh',
      terminalHandle: 'term_ssh',
      paneKey: 'tab_ssh:66666666-6666-4666-8666-666666666666',
      processIncarnation: 'inc-ssh',
      worktreeInstanceId: 'inst-ssh-1',
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'devbox' })
    })
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, {
      mode: 'new-top-level',
      repoSelector: 'id:repo-ssh',
      targetHostId: 'ssh:devbox',
      canonicalTarget: {
        kind: 'project',
        hostId: 'ssh:devbox',
        repoId: 'repo-ssh',
        repoKind: 'git',
        displayName: 'ssh-api'
      }
    })
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${wSsh.dispatchId}`, subject: 'SSH project', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wSsh.dispatchId}`)).toHaveLength(0)
  })

  it('re-verifies persisted SQLite target provenance on unread mail follow-through across Orca restart, blocks takesMailOf bypass, and protects mixed-origin batches', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-work-target-restart-')))
    tempDirs.push(root)
    const dbFile = join(root, 'orchestration.sqlite')
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      dbFile,
      tag: 'restart'
    })
    const run = fx.db.createRun({
      objective: 'Restart & unread mail follow-through',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })

    const wAcme = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Initial acme task',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme',
      worktreeInstanceId: 'inst-acme-1'
    })
    const wOther = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Initial other task',
      worktreeId: 'wt-other',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-other',
      worktreeInstanceId: 'inst-other-1'
    })

    const explicitTarget = makeExplicitWorkspaceTarget()
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, explicitTarget)
    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            { to: `dispatch:${wAcme.dispatchId}`, subject: 'Unread targeted', body: 'Run check' },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)
    fx.runtime.botWorkTargets.clearForTurn(BOT_SESSION_ID)

    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            { to: `dispatch:${wOther.dispatchId}`, subject: 'Old untargeted', body: 'Continue' },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    for (const id of [wAcme.dispatchId, wOther.dispatchId]) {
      fx.db.completeDispatch(id)
      fx.db.db
        .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
        .run(id)
      markUnreadFollowUpMail(fx.db, id)
    }

    // Simulate real Orca restart: flush microtasks, reopen on-disk SQLite with fresh runtime (empty botWorkTargets).
    await Promise.resolve()
    const reopenedDb = new OrchestrationDb(dbFile)
    dbs.push(reopenedDb)
    fx.runtime.setOrchestrationDb(reopenedDb)
    fx.db.close()
    const restartedRuntime = new OrcaRuntimeService(fx.store)
    restartedRuntime.setOrchestrationDb(reopenedDb)
    fx.bindRuntimeWorkspaceStubs(restartedRuntime)
    expect(restartedRuntime.botWorkTargets.getForTurn(BOT_SESSION_ID)).toBeUndefined()

    // Drift incarnation during restart (inst-acme-1 -> inst-acme-2): follow-through refuses and notifies coordinator.
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wAcme.dispatchId)
    expect(resolveWorkerLineage(reopenedDb, wAcme.dispatchId)?.latest.id).toBe(wAcme.dispatchId)
    expect(
      reopenedDb
        .getUnreadMessages(`run:${run.id}`)
        .some((msg) => msg.subject === 'Mail did not reach the finished worker')
    ).toBe(true)

    // Mixed-origin mailbox (untargeted first, drifted targeted second):
    // holds only the invalid targeted message without blocking ordinary unread follow-through.
    const wMixed = seedLocalWorker(reopenedDb, {
      runId: run.id,
      spec: 'Mixed mailbox worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_mixed',
      paneKey: 'tab_mixed:55555555-5555-4555-8555-555555555555',
      processIncarnation: 'inc-mixed',
      worktreeInstanceId: 'inst-acme-1'
    })
    reopenedDb.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wMixed.dispatchId}`,
      subject: 'Untargeted first',
      body: 'Earlier note',
      type: 'status',
      runId: run.id
    })
    const driftedMixedMsg = reopenedDb.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wMixed.dispatchId}`,
      subject: 'Targeted second',
      body: 'Deploy auth fix',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    reopenedDb.completeDispatch(wMixed.dispatchId)
    reopenedDb.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(wMixed.dispatchId)
    markUnreadFollowUpMail(reopenedDb, wMixed.dispatchId)
    vi.spyOn(restartedRuntime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(
      'exited'
    )
    const showWorkspaceSpy = vi.spyOn(restartedRuntime, 'showManagedTerminalWorkspace')
    showWorkspaceSpy.mockClear()
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wMixed.dispatchId)
    // Ordinary mail proceeded into follow-up placement while drifted targeted mail stayed held with 1 hold notice.
    expect(showWorkspaceSpy).toHaveBeenCalledWith('id:wt-acme')
    expect(reopenedDb.getMessageById(driftedMixedMsg.id)?.to_handle).toBe(
      `dispatch:${wMixed.dispatchId}`
    )
    expect(reopenedDb.getMessageById(driftedMixedMsg.id)?.read).toBe(0)
    expect(
      reopenedDb
        .getUnreadMessages(`run:${run.id}`)
        .filter(
          (msg) =>
            msg.from_handle === `dispatch:${wMixed.dispatchId}` &&
            msg.payload?.includes('work_target_mail_held')
        )
    ).toHaveLength(1)

    // Conflicting targeted provenances (Target A valid + Target B mismatched):
    // holds only Target B while letting valid Target A enter follow-up placement.
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'
    const wConflict = seedLocalWorker(reopenedDb, {
      runId: run.id,
      spec: 'Conflicting targets worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_conflict',
      paneKey: 'tab_conflict:77777777-7777-4777-8777-777777777777',
      processIncarnation: 'inc-conflict',
      worktreeInstanceId: 'inst-acme-1'
    })
    reopenedDb.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wConflict.dispatchId}`,
      subject: 'Target A',
      body: 'Acme',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })
    const mismatchedConflictMsg = reopenedDb.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wConflict.dispatchId}`,
      subject: 'Target B',
      body: 'Other',
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
    reopenedDb.completeDispatch(wConflict.dispatchId)
    reopenedDb.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(wConflict.dispatchId)
    markUnreadFollowUpMail(reopenedDb, wConflict.dispatchId)
    showWorkspaceSpy.mockClear()
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wConflict.dispatchId)
    expect(showWorkspaceSpy).toHaveBeenCalledWith('id:wt-acme')
    expect(reopenedDb.getMessageById(mismatchedConflictMsg.id)?.to_handle).toBe(
      `dispatch:${wConflict.dispatchId}`
    )
    expect(reopenedDb.getMessageById(mismatchedConflictMsg.id)?.read).toBe(0)
    expect(
      reopenedDb
        .getUnreadMessages(`run:${run.id}`)
        .filter(
          (msg) =>
            msg.from_handle === `dispatch:${wConflict.dispatchId}` &&
            msg.payload?.includes('work_target_mail_held')
        )
    ).toHaveLength(1)

    const wCorrupt = seedLocalWorker(reopenedDb, {
      runId: run.id,
      spec: 'Corrupt provenance worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_corrupt',
      paneKey: 'tab_corrupt:88888888-8888-4888-8888-888888888888',
      processIncarnation: 'inc-corrupt',
      worktreeInstanceId: 'inst-acme-1'
    })
    const corruptMsg = reopenedDb.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${wCorrupt.dispatchId}`,
      subject: 'Corrupt provenance mail',
      body: 'Fail closed',
      type: 'status',
      runId: run.id
    })
    reopenedDb.db
      .prepare(
        `INSERT INTO message_work_target_provenance (message_id, source_origin, placement_json)
         VALUES (?, ?, ?)`
      )
      .run(corruptMsg.id, `session:${BOT_SESSION_ID}`, '{not-valid-json')
    reopenedDb.completeDispatch(wCorrupt.dispatchId)
    reopenedDb.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(wCorrupt.dispatchId)
    markUnreadFollowUpMail(reopenedDb, wCorrupt.dispatchId)
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wCorrupt.dispatchId)
    expect(resolveWorkerLineage(reopenedDb, wCorrupt.dispatchId)?.latest.id).toBe(
      wCorrupt.dispatchId
    )

    // Matching persisted targeted mail after restart passes verification and enters follow-up placement.
    const showAcmeAfterRestart = vi.spyOn(restartedRuntime, 'showManagedTerminalWorkspace')
    showAcmeAfterRestart.mockClear()
    vi.spyOn(restartedRuntime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(
      'exited'
    )
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wAcme.dispatchId)
    expect(showAcmeAfterRestart.mock.calls).toEqual(
      expect.arrayContaining([['id:wt-acme', 'local'], ['id:wt-acme']])
    )

    // Direct takesMailOf cannot bypass active turn target.
    restartedRuntime.botWorkTargets.setForTurn(BOT_SESSION_ID, explicitTarget)
    const bypassPlaceSpy = vi.fn(async () => ({
      delivery: 'follow_up' as const,
      worktreeId: 'wt-other',
      terminal: 'term_other'
    }))
    await expect(
      startWorker(
        { from: BOT_ADDRESS, run: run.id, spec: 'Try takesMailOf bypass' },
        {
          runtime: restartedRuntime,
          orchestrationCaller: {
            address: BOT_ADDRESS,
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: BOT_SESSION_ID,
            sessionId: BOT_SESSION_ID,
            workspaceId: folderWorkspaceKey(fx.botHomeFolder.id)
          }
        },
        {
          of: wOther.dispatchId,
          addressed: wOther.dispatchId,
          takesMailOf: wOther.dispatchId,
          place: bypassPlaceSpy
        }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError &&
        error.code === 'invalid_argument' &&
        typeof error.data === 'object' &&
        error.data !== null &&
        'effectsApplied' in error.data &&
        error.data.effectsApplied === false
    )
    expect(bypassPlaceSpy).not.toHaveBeenCalled()

    // Pre-existing untargeted unread mail on wOther is preserved even while BOT_SESSION_ID has an active target.
    const showOtherSpy = vi.spyOn(restartedRuntime, 'showManagedTerminalWorkspace')
    showOtherSpy.mockClear()
    await continueUnreadWorkerMailNow(restartedRuntime, reopenedDb, wOther.dispatchId)
    expect(showOtherSpy).toHaveBeenCalledWith('id:wt-other')
  })
})
