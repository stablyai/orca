import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db/orchestration-db'
import { OrchestrationMailboxOwner, type OrchestrationMailboxTerminal } from './mailbox-owner'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function terminalFor(tabId: string, leafId: string): OrchestrationMailboxTerminal {
  const paneKey = `${tabId}:${leafId}`
  return {
    ptyId: `pty_${leafId}`,
    handle: `term_${paneKey}`,
    paneKeys: [paneKey],
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true
  }
}

function ownerFor(database: OrchestrationDb): OrchestrationMailboxOwner {
  return new OrchestrationMailboxOwner({
    getDb: () => database,
    getTerminal: () => null,
    getTerminalProcessIncarnation: () => 'process_worker',
    onRoutedMessageTypes: () => {},
    onForeignMailboxRouted: () => {}
  })
}

function attachRemoteDispatch(database: OrchestrationDb, paneKey: string): void {
  database.createRemoteDispatchAttachment({
    runId: 'run-home',
    dispatchId: 'ctx_remote',
    taskId: 'task_remote',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: 'worker_epoch',
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'remote_start',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'remote_payload'
    }
  })
  database.prepareRemoteAttachmentAuthority({
    dispatchId: 'ctx_remote',
    paneKey,
    processIncarnation: 'process_worker',
    worktreeId: 'repo::worktree',
    terminalHandle: `term_${paneKey}`,
    setupState: 'not_applicable',
    effects: []
  })
}

describe('OrchestrationMailboxOwner.resolve', () => {
  // Idle titles re-resolve mailbox ownership; wildcard queries must not recompile on every title.
  it.each([
    ['a plain pane', false],
    ['a pane with a remote Dispatch', true]
  ])('reuses every statement it prepares for %s', (_label, attached) => {
    db = new OrchestrationDb(':memory:')
    const terminal = terminalFor('tab_a', 'leaf_a')
    if (attached) {
      attachRemoteDispatch(db, 'tab_a:leaf_a')
    }
    const owner = ownerFor(db)
    const prepare = db.db.prepare.bind(db.db)
    const prepared = new Set<string>()
    vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      prepared.add(sql)
      return prepare(sql)
    })

    const mailbox = owner.resolve(terminal)

    expect(mailbox).toBe(attached ? 'dispatch:ctx_remote' : 'term_tab_a:leaf_a')
    expect(prepared.size).toBeGreaterThan(0)
    for (const sql of prepared) {
      expect(prepare(sql), sql).toBe(prepare(sql))
    }
  })
})
