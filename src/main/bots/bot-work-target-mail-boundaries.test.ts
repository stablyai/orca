import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { markUnreadFollowUpMail } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { readMessageWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { passHeldWorkerMail } from '../runtime/rpc/methods/orchestration/messaging/settled-worker-follow-through'
import { registerWorkerStartWait } from '../runtime/rpc/methods/orchestration/worker/start/readiness/worker-start-waits'
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

describe('unread targeted mail verification across mailbox readdress & hand-back boundaries', () => {
  it('passHeldWorkerMail readiness callback holds drifted targeted mail (recoverable + deduplicated notice), delivers ordinary mail, and delivers targeted mail when checkout matches', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'held-mail-readiness'
    })
    const run = fx.db.createRun({
      objective: 'Held mail readiness boundary',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const w1 = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Initial acme worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1'
    })

    const explicitTarget = makeExplicitWorkspaceTarget()
    const ordinaryMsg = fx.db.insertMessage({
      from: 'term_human',
      to: `dispatch:${w1.dispatchId}`,
      subject: 'Ordinary note',
      body: 'Plain untargeted follow-up',
      type: 'status',
      runId: run.id
    })
    const targetedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${w1.dispatchId}`,
      subject: 'Targeted work',
      body: 'Run migration on inst-acme-1 only',
      type: 'status',
      runId: run.id,
      workTargetProvenance: { sourceOrigin: `session:${BOT_SESSION_ID}`, placement: explicitTarget }
    })

    fx.db.completeDispatch(w1.dispatchId)
    fx.db.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(w1.dispatchId)
    markUnreadFollowUpMail(fx.db, w1.dispatchId)

    // Create a starting follow-up W2 linked to W1, blocked on a real worker-start readiness wait.
    const w2 = fx.db.createStartingWorkerDispatch({
      creator: { kind: 'terminal', handle: BOT_ADDRESS, orcaSessionId: BOT_SESSION_ID },
      maxDepth: 3,
      taskSpec: 'Follow-up worker',
      taskRunId: run.id,
      followUpOf: w1.dispatchId,
      startOptions: {
        worktree: 'id:wt-acme',
        resolvedWorktreeId: 'wt-acme',
        resolvedWorktreeInstanceId: 'inst-acme-1',
        agent: 'codex'
      },
      runtimeEpoch: fx.runtime.getRuntimeId()
    })
    fx.db.prepareStartingWorkerAuthority({
      dispatchId: w2.dispatch.id,
      handle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme-2',
      worktreeId: 'wt-acme',
      worktreeInstanceId: 'inst-acme-1',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })

    let releaseStartWait!: () => void
    registerWorkerStartWait(
      w2.dispatch.id,
      () =>
        new Promise<void>((resolve) => {
          releaseStartWait = resolve
        })
    )

    // Register the real afterWorkerStartWait('held-mail') callback while W2 is still starting.
    await passHeldWorkerMail(fx.runtime, fx.db, w2.dispatch.id)

    // Checkout is replaced before W2 becomes ready!
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-2'
    fx.db.markWorkerDispatchReady(w2.dispatch.id)
    releaseStartWait()
    await vi.waitFor(() => {
      expect(fx.db.getUnreadMessages(`dispatch:${w2.dispatch.id}`).map((m) => m.id)).toEqual([
        ordinaryMsg.id
      ])
      expect(
        fx.db
          .getUnreadMessages(`run:${run.id}`)
          .some((m) => m.subject === 'Mail did not reach the finished worker')
      ).toBe(true)
    })

    // Ordinary mail moved to W2; targeted mail stayed held & recoverable on W1; coordinator got ONE hold notice.
    const w2Unread = fx.db.getUnreadMessages(`dispatch:${w2.dispatch.id}`)
    expect(w2Unread.map((m) => m.id)).toEqual([ordinaryMsg.id])
    const w1Unread = fx.db.getUnreadMessages(`dispatch:${w1.dispatchId}`)
    expect(w1Unread.map((m) => m.id)).toEqual([targetedMsg.id])
    expect(fx.db.getDispatchContextById(w1.dispatchId)?.follow_up_mail_at).not.toBeNull()

    const runMessagesAfterDrift = fx.db.getUnreadMessages(`run:${run.id}`)
    expect(runMessagesAfterDrift.some((m) => m.id === targetedMsg.id)).toBe(false)
    const holdNotices = runMessagesAfterDrift.filter(
      (m) => m.type === 'escalation' && m.subject === 'Mail did not reach the finished worker'
    )
    expect(holdNotices).toHaveLength(1)

    // Repeating passHeldWorkerMail while still drifted must NOT send duplicate notices.
    await passHeldWorkerMail(fx.runtime, fx.db, w2.dispatch.id)
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.subject === 'Mail did not reach the finished worker')
    ).toHaveLength(1)

    // Recovery: when destination matches target again, held targeted mail moves cleanly to W2!
    fx.worktrees.get('wt-acme')!.instanceId = 'inst-acme-1'
    await passHeldWorkerMail(fx.runtime, fx.db, w2.dispatch.id)
    expect(fx.db.getUnreadMessages(`dispatch:${w1.dispatchId}`)).toHaveLength(0)
    expect(fx.db.getUnreadMessages(`dispatch:${w2.dispatch.id}`).map((m) => m.id)).toEqual(
      expect.arrayContaining([ordinaryMsg.id, targetedMsg.id])
    )
    expect(fx.db.getDispatchContextById(w1.dispatchId)?.follow_up_mail_at).toBeNull()
  })

  it('overlapping orchestration.check on a settling worker routes ordinary mail to run:<id> while holding targeted mail on dispatch:<id> with a single notice', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'check-overlap'
    })
    const run = fx.db.createRun({
      objective: 'Overlapping check settlement',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const w1 = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Worker checking mail',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme-1',
      worktreeInstanceId: 'inst-acme-1'
    })
    vi.spyOn(fx.runtime, 'getTerminalProcessIncarnation').mockReturnValue('inc-acme-1')

    // Start a real orchestration.check --wait while W1 is active and its inbox is empty.
    const origWaitForMessage = fx.runtime.waitForMessage.bind(fx.runtime)
    let enteredWait!: () => void
    const waitEntered = new Promise<void>((resolve) => {
      enteredWait = resolve
    })
    vi.spyOn(fx.runtime, 'waitForMessage').mockImplementation((handle, opts) => {
      enteredWait()
      return origWaitForMessage(handle, opts)
    })
    const checkPromise = fx.dispatcher.dispatch(
      rpcReq('orchestration.check', {
        terminal: 'term_acme',
        wait: true,
        timeoutMs: 5_000
      })
    )
    await waitEntered

    // Now targeted work AND ordinary mail arrive, and W1 settles while check is waiting!
    const ordinaryMsg = fx.db.insertMessage({
      from: 'term_human',
      to: `dispatch:${w1.dispatchId}`,
      subject: 'Ordinary status',
      body: 'Safe for Run inbox',
      type: 'status',
      runId: run.id
    })
    const targetedMsg = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${w1.dispatchId}`,
      subject: 'Targeted follow-up',
      body: 'Must never appear as ordinary Run mail',
      type: 'status',
      runId: run.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: makeExplicitWorkspaceTarget()
      }
    })
    fx.db.completeDispatch(w1.dispatchId)
    fx.runtime.notifyMessageArrived(`dispatch:${w1.dispatchId}`, 'status')

    const checkResult = await checkPromise
    expect(checkResult).toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })

    // Ordinary mail moved to run:<id>; targeted mail stayed held on dispatch:<w1>; ONE hold notice sent.
    const runInbox = fx.db.getUnreadMessages(`run:${run.id}`)
    expect(runInbox.some((m) => m.id === ordinaryMsg.id)).toBe(true)
    expect(runInbox.some((m) => m.id === targetedMsg.id)).toBe(false)
    expect(
      runInbox.filter((m) => m.subject === 'Mail did not reach the finished worker')
    ).toHaveLength(1)
    expect(fx.db.getUnreadMessages(`dispatch:${w1.dispatchId}`).map((m) => m.id)).toEqual([
      targetedMsg.id
    ])
    expect(fx.db.getDispatchContextById(w1.dispatchId)?.follow_up_mail_at).not.toBeNull()
  })

  it('helper-mailbox-hand-back returns ordinary helper reports and questions to run:<id> while holding targeted work mail with a deduplicated notice', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'helper-hand-back'
    })
    const run = fx.db.createRun({
      objective: 'Helper hand-back boundary',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const parentWorker = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Parent worker with helper',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-parent',
      worktreeInstanceId: 'inst-acme-1'
    })
    // Spawn a real helper child whose creator_dispatch_id is parentWorker.dispatchId.
    const helper = fx.db.createStartingWorkerDispatch({
      creator: {
        kind: 'terminal',
        handle: 'term_acme',
        paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111'
      },
      requiredCreatorDispatchId: parentWorker.dispatchId,
      maxDepth: 3,
      taskSpec: 'Helper sub-task',
      taskRunId: run.id,
      startOptions: { worktree: 'id:wt-acme', agent: 'codex' },
      runtimeEpoch: fx.runtime.getRuntimeId()
    })
    expect(helper.dispatch.creator_dispatch_id).toBe(parentWorker.dispatchId)

    const helperReport = fx.db.insertMessage({
      from: `dispatch:${helper.dispatch.id}`,
      to: `dispatch:${parentWorker.dispatchId}`,
      subject: 'Helper finished',
      body: 'Done',
      type: 'worker_done',
      runId: run.id
    })
    const helperQuestion = fx.db.createQuestion({
      runId: run.id,
      dispatchId: helper.dispatch.id,
      askerHandle: `dispatch:${helper.dispatch.id}`,
      question: 'Should I proceed?',
      to: `dispatch:${parentWorker.dispatchId}`
    })
    const targetedWork = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: `dispatch:${parentWorker.dispatchId}`,
      subject: 'Targeted parent work',
      body: 'Keep targeted work out of Run inbox',
      type: 'status',
      runId: run.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: makeExplicitWorkspaceTarget()
      }
    })

    // Settling parentWorker triggers closeQuestionsForDispatch -> handHelperMailToRun -> post-commit offerHandedBackMail.
    fx.db.completeDispatch(parentWorker.dispatchId)
    await vi.waitFor(() => {
      expect(
        fx.db
          .getUnreadMessages(`run:${run.id}`)
          .filter((m) => m.subject === 'Mail did not reach the finished worker')
      ).toHaveLength(1)
    })

    const runInbox = fx.db.getUnreadMessages(`run:${run.id}`)
    expect(runInbox.some((m) => m.id === helperReport.id)).toBe(true)
    expect(runInbox.some((m) => m.id === helperQuestion.message.id)).toBe(true)
    expect(runInbox.some((m) => m.id === targetedWork.id)).toBe(false)
    expect(fx.db.getUnreadMessages(`dispatch:${parentWorker.dispatchId}`).map((m) => m.id)).toEqual(
      [targetedWork.id]
    )
    expect(fx.db.getDispatchContextById(parentWorker.dispatchId)?.follow_up_mail_at).not.toBeNull()

    // Re-running closeQuestionsForDispatch produces zero duplicate notices.
    fx.db.closeQuestionsForDispatch(parentWorker.dispatchId)
    await Promise.resolve()
    await Promise.resolve()
    expect(
      fx.db
        .getUnreadMessages(`run:${run.id}`)
        .filter((m) => m.subject === 'Mail did not reach the finished worker')
    ).toHaveLength(1)
  })

  it('preserves backward compatibility with pre-provenance SQLite DBs, blocks corrupt provenance, and stops coordinator triggers from sweeping targeted direct mail', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-work-target-legacy-db-')))
    tempDirs.push(root)
    const dbFile = join(root, 'legacy-orchestration.db')

    // 1) Simulate an older DB before message_work_target_provenance existed.
    const oldDb = new OrchestrationDb(dbFile)
    const oldRun = oldDb.createRun({
      objective: 'Legacy compatibility run',
      coordinatorHandle: 'term_acme',
      coordinatorPaneKey: 'tab_acme:11111111-1111-4111-8111-111111111111'
    })
    const oldWorker = seedLocalWorker(oldDb, {
      runId: oldRun.id,
      spec: 'Legacy worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-legacy',
      worktreeInstanceId: 'inst-acme-1'
    })
    const legacyOrdinary = oldDb.insertMessage({
      from: 'term_human',
      to: `dispatch:${oldWorker.dispatchId}`,
      subject: 'Pre-upgrade ordinary mail',
      body: 'Should route normally',
      type: 'status',
      runId: oldRun.id
    })
    oldDb.db.exec('DROP TABLE message_work_target_provenance')
    oldDb.close()

    // Reopen on current build: table recreates cleanly, schema version stays compatible, legacy ordinary mail still routes.
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      dbFile,
      tag: 'legacy-reopen'
    })
    expect(fx.db.db.pragma('user_version', { simple: true })).toBe(51)
    const routed = fx.db.routeUnreadDispatchMailboxToRunMailbox(oldWorker.dispatchId, oldRun.id)
    expect(routed.routedCount).toBe(1)
    expect(
      fx.db.getUnreadMessages(`run:${oldRun.id}`).some((m) => m.id === legacyOrdinary.id)
    ).toBe(true)

    // 2) Targeted direct mail to a coordinator-aliased terminal is NOT rewritten into run:<id> by trigger or direct routing.
    const targetedDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_acme',
      subject: 'Targeted bare terminal work',
      body: 'Keep direct handle',
      type: 'status',
      runId: oldRun.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: makeProjectTarget()
      }
    })
    expect(fx.db.getMessageById(targetedDirect.id)?.to_handle).toBe('term_acme')
    expect(readMessageWorkTargetProvenance(fx.db, targetedDirect.id).kind).toBe('valid')
    expect(fx.db.routeUnreadDirectMessagesToRunMailbox(oldRun.id, 'term_acme').routedCount).toBe(0)
    expect(fx.db.routeAllUnreadDirectMessagesToRunMailbox(oldRun.id, 'term_acme')).toBe(0)
    expect(fx.db.getMessageById(targetedDirect.id)?.to_handle).toBe('term_acme')

    // Ordinary direct mail to that same coordinator alias still routes into run:<id> immediately via trigger.
    const ordinaryDirect = fx.db.insertMessage({
      from: 'term_human',
      to: 'term_acme',
      subject: 'Ordinary coordinator mail',
      body: 'Routes to Run',
      type: 'status',
      runId: oldRun.id
    })
    expect(fx.db.getMessageById(ordinaryDirect.id)?.to_handle).toBe(`run:${oldRun.id}`)

    // 3) Corrupt provenance JSON stays held (fail-closed) rather than moving to a worker or Run inbox.
    seedLocalWorker(fx.db, {
      runId: oldRun.id,
      spec: 'Active verification worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_active',
      paneKey: 'tab_active:33333333-3333-4333-8333-333333333333',
      processIncarnation: 'inc-active',
      worktreeInstanceId: 'inst-acme-1'
    })
    vi.spyOn(fx.runtime, 'getTerminalProcessIncarnation').mockReturnValue('inc-active')
    const validTargetedDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_active',
      subject: 'Matching targeted direct mail',
      body: 'Allowed on matching active worker',
      type: 'status',
      runId: oldRun.id,
      workTargetProvenance: {
        sourceOrigin: `session:${BOT_SESSION_ID}`,
        placement: makeExplicitWorkspaceTarget()
      }
    })
    const corruptTargetedDirect = fx.db.insertMessage({
      from: BOT_ADDRESS,
      to: 'term_active',
      subject: 'Corrupt provenance mail',
      body: 'Must stay held',
      type: 'status',
      runId: oldRun.id
    })
    fx.db.db
      .prepare(
        `INSERT INTO message_work_target_provenance (message_id, source_origin, placement_json)
         VALUES (?, ?, ?)`
      )
      .run(corruptTargetedDirect.id, `session:${BOT_SESSION_ID}`, '{not-valid-json')

    const checkActive = await fx.dispatcher.dispatch(
      rpcReq('orchestration.check', { terminal: 'term_active' })
    )
    expect(checkActive.ok).toBe(true)
    if (
      checkActive.ok &&
      checkActive.result &&
      typeof checkActive.result === 'object' &&
      'messages' in checkActive.result &&
      Array.isArray(checkActive.result.messages)
    ) {
      const checkedIds = checkActive.result.messages.flatMap((m) =>
        m && typeof m === 'object' && 'id' in m && typeof m.id === 'string' ? [m.id] : []
      )
      expect(checkedIds).toContain(validTargetedDirect.id)
      expect(checkedIds).not.toContain(corruptTargetedDirect.id)
    }
    expect(fx.db.getMessageById(corruptTargetedDirect.id)?.to_handle).toBe('term_active')
    expect(fx.db.getUnreadMessages('term_active').map((m) => m.id)).toEqual([
      corruptTargetedDirect.id
    ])
  })
})
