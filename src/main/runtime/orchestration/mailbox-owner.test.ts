import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { selectTerminalMailHandoff, terminalMailHandoffCanSubmit } from './terminal-mail-settlement'
import { OrchestrationDb } from './db/orchestration-db'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function leafFor(tabId: string, leafId: string): OrchestrationMailboxLeaf {
  return {
    tabId,
    leafId,
    paneRuntimeId: 1,
    ptyId: `pty_${leafId}`,
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null
  }
}

function ownerFor(database: OrchestrationDb): OrchestrationMailboxOwner {
  return new OrchestrationMailboxOwner({
    getDb: () => database,
    getLeaf: () => undefined,
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    getTerminalHandleForLeafKey: (leafKey) => `term_${leafKey}`,
    getTerminalProcessIncarnation: () => 'process_worker',
    onRoutedMessageTypes: () => {},
    onForeignMailboxRouted: () => {}
  })
}

function attachRemoteDispatch(
  database: OrchestrationDb,
  paneKey: string,
  dispatchId = 'ctx_remote',
  runId = 'run-home'
): void {
  database.createRemoteDispatchAttachment({
    runId,
    dispatchId,
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
    dispatchId,
    paneKey,
    processIncarnation: 'process_worker',
    worktreeId: 'repo::worktree',
    terminalHandle: `term_${paneKey}`,
    setupState: 'not_applicable',
    effects: []
  })
}

describe('OrchestrationMailboxOwner.resolve', () => {
  // Why: every idle agent title re-resolves its pane's mailbox, so a statement the SQLite cache
  // refuses (a `SELECT *`) recompiles on each title while output streams.
  it.each([
    ['a plain pane', false],
    ['a pane with a remote Dispatch', true]
  ])('reuses every statement it prepares for %s', (_label, attached) => {
    db = new OrchestrationDb(':memory:')
    const leaf = leafFor('tab_a', 'leaf_a')
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

    const mailbox = owner.resolve(leaf)

    expect(mailbox).toBe(attached ? 'dispatch:ctx_remote' : 'term_tab_a:leaf_a')
    expect(prepared.size).toBeGreaterThan(0)
    for (const sql of prepared) {
      expect(prepare(sql), sql).toBe(prepare(sql))
    }
  })
})

it.each([
  ['attachment-only', false],
  ['attachment-loopback', false],
  ['local-loopback', false],
  ['attachment-only', true],
  ['attachment-loopback', true],
  ['local-loopback', true],
  ['legacy-handle', true]
] as const)(
  'fences automatic input, check and ack by the actual routed %s source (reminted=%s)',
  (mode, reminted) => {
    db = new OrchestrationDb(':memory:')
    const leaf = leafFor('tab_a', '11111111-1111-4111-8111-111111111111')
    const pane = `${leaf.tabId}:${leaf.leafId}`
    const storedPane = reminted ? `tab_old:${leaf.leafId}` : pane
    const run = db.createRun({
      objective: 'authority',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'coord:pane'
    })
    const local =
      mode !== 'attachment-only'
        ? createRootDispatch(
            db,
            db.createTask({ runId: run.id, spec: 'loopback' }).id,
            mode === 'legacy-handle' ? `term_${pane}` : 'local',
            mode === 'legacy-handle'
              ? undefined
              : mode === 'local-loopback'
                ? storedPane
                : 'other:pane',
            undefined,
            'process_worker'
          )
        : null
    const id = local?.id ?? 'ctx_remote'
    const attachment = mode.startsWith('attachment')
    if (mode !== 'legacy-handle') {
      attachRemoteDispatch(db, attachment ? storedPane : 'remote:pane', id, run.id)
    }
    const mailbox = `dispatch:${id}`
    expect(ownerFor(db).resolve(leaf)).toBe(mailbox)
    const params = {
      runId: run.id,
      mailboxHandle: mailbox,
      consumerGeneration: attachment ? 1 : local!.consumer_generation,
      consumerSource: attachment ? ('attachment' as const) : ('dispatch' as const)
    }
    db.insertMessage({ runId: run.id, from: 'sender', to: mailbox, subject: 'already checked' })
    const delivery = db.getOrCreateMailboxDelivery(params)!.delivery
    const message = db.insertMessage({
      runId: run.id,
      from: 'sender',
      to: mailbox,
      subject: 'fresh'
    })
    const select = () =>
      selectTerminalMailHandoff({
        db: db!,
        mailbox,
        route: [pane, `term_${pane}`],
        target: null,
        wasAbandoned: () => false,
        waiters: undefined,
        reservedTypes: undefined
      })
    const reserved = select()
    expect(reserved.map((row) => row.id)).toEqual([message.id])
    const authority = db.mailboxHandoffAuthority(mailbox, [pane, `term_${pane}`])
    expect(authority).not.toBe('')
    expect(terminalMailHandoffCanSubmit(db, mailbox, reserved, () => false)).toBe(true)
    if (local && mode !== 'legacy-handle') {
      db.db
        .prepare(
          attachment
            ? 'UPDATE dispatch_contexts SET consumer_generation = consumer_generation + 1 WHERE id = ?'
            : 'UPDATE remote_dispatch_attachments SET consumer_generation = consumer_generation + 1 WHERE dispatch_id = ?'
        )
        .run(id)
      expect(db.isMailHandoffCurrent(mailbox, reserved, authority)).toBe(true)
      expect(db.getOrCreateMailboxDelivery(params)?.delivery.id).toBe(delivery.id)
    }
    db.db
      .prepare(
        attachment
          ? 'UPDATE remote_dispatch_attachments SET consumer_generation = consumer_generation + 1 WHERE dispatch_id = ?'
          : 'UPDATE dispatch_contexts SET consumer_generation = consumer_generation + 1 WHERE id = ?'
      )
      .run(id)
    expect(db.isMailHandoffCurrent(mailbox, reserved, authority)).toBe(false)
    expect(terminalMailHandoffCanSubmit(db, mailbox, reserved, () => false)).toBe(false)
    expect(() => db!.getOrCreateMailboxDelivery(params)).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(() => db!.acknowledgeMailboxDelivery({ ...params, deliveryId: delivery.id })).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    const adopted = select()
    expect(adopted.map((row) => row.id)).toEqual([message.id])
    expect(adopted[0]?.recovery_used).toBe(0)
    expect(db.getMessageById(message.id)?.read).toBe(0)
  }
)

it('keeps pane fallback, bound-handle precedence and structured session authority distinct', () => {
  db = new OrchestrationDb(':memory:')
  const leaf = leafFor('newtab', '11111111-1111-4111-8111-111111111111')
  const pane = `${leaf.tabId}:${leaf.leafId}`
  const run = db.createRun({
    objective: 'route identity',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: 'coord:pane'
  })
  const dispatch = createRootDispatch(
    db,
    db.createTask({ runId: run.id, spec: 'pane owner' }).id,
    'pane-owner',
    `oldtab:${leaf.leafId}`
  )
  const mailbox = `dispatch:${dispatch.id}`
  const owner = ownerFor(db)
  expect(owner.resolve(leaf, undefined, { terminalHandle: 'unbound' })).toBe(mailbox)
  const authority = db.mailboxHandoffAuthority(mailbox, [pane, 'unbound'])
  expect(authority).not.toBe('')
  expect(JSON.parse(authority)[0]).toBe(pane)
  expect(db.mailboxHandoffAuthority(mailbox, pane)).toBe(authority)
  const other = createRootDispatch(
    db,
    db.createTask({ runId: run.id, spec: 'handle owner' }).id,
    'bound-handle',
    'other:pane'
  )
  attachRemoteDispatch(db, pane, dispatch.id, run.id)
  expect(owner.resolve(leaf, undefined, { terminalHandle: 'bound-handle' })).toBe(
    `dispatch:${other.id}`
  )
  expect(db.mailboxHandoffAuthority(mailbox, [pane, 'bound-handle'])).toBe('')
  expect(db.mailboxHandoffAuthority(`dispatch:${other.id}`, [pane, 'bound-handle'])).not.toBe('')
  expect(db.mailboxHandoffAuthority(mailbox, ['missing:pane', 'unbound'])).toBe('')
  db.db
    .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
    .run('session', dispatch.id)
  expect(db.mailboxHandoffAuthority(mailbox, 'session')).not.toBe('')
})
