import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

describe('creator lineage', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => db.close())

  it('keeps a paired bot worker lineage for guidance without changing the helper surface', () => {
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      runId: 'run_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      botLineage: true,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote',
      paneKey: 'pane:worker',
      processIncarnation: 'worker:1',
      worktreeId: 'worktree',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })

    const creator = {
      kind: 'terminal',
      handle: 'term_worker',
      paneKey: 'pane:worker',
      processIncarnation: 'worker:1'
    } as const
    expect(db.creatorStartsChatWorkers(creator)).toBe(false)
    expect(db.creatorHasBotLineage(creator)).toBe(true)
  })

  it('does not inherit a matching incarnation from another pane', () => {
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_other_pane',
      runId: 'run_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      botLineage: true,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_other_pane',
      paneKey: 'pane:other',
      processIncarnation: 'worker:1',
      worktreeId: 'worktree',
      terminalHandle: 'term_other',
      setupState: 'not_applicable',
      effects: []
    })

    expect(
      db.creatorStartsChatWorkers({
        kind: 'terminal',
        handle: 'term_worker',
        paneKey: 'pane:worker',
        processIncarnation: 'worker:1'
      })
    ).toBe(false)
  })

  it('persists a direct bot dispatch lineage', () => {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'system' },
      botLineage: true,
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    expect(dispatch.chat_lineage).toBeNull()
    expect(dispatch.bot_lineage).toBe(1)
  })

  it('keeps attached bot guidance through an unstamped local helper without changing its surface', () => {
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      runId: 'run_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      botLineage: true,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote',
      paneKey: 'pane:remote',
      processIncarnation: 'remote:1',
      worktreeId: 'worktree',
      terminalHandle: 'term_remote',
      setupState: 'not_applicable',
      effects: []
    })
    const task = db.createTask({ runId: 'run_local', spec: 'work' })
    const helper = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_helper',
      creator: {
        kind: 'terminal',
        handle: 'term_remote',
        paneKey: 'pane:remote',
        processIncarnation: 'remote:1'
      },
      botLineage: true,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db.prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?").run(helper.id)

    const creator = {
      kind: 'terminal',
      handle: 'term_helper',
      paneKey: helper.assignee_pane_key ?? undefined
    } as const
    expect(helper.chat_lineage).toBeNull()
    expect(helper.bot_lineage).toBe(1)
    expect(db.creatorStartsChatWorkers(creator)).toBe(false)
    expect(db.creatorHasBotLineage(creator)).toBe(true)
  })
})
