import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { PANE } from '../../../../agent-hooks/server/testing/server.test-fixtures'

const fixture = runtimeFixture()

it.each([
  [100, 0],
  [1000, 0],
  [100, 1],
  [1000, 1]
])(
  'bounds the real timer by %i stale open dispatches and %i working worker',
  (history, working) => {
    const { db } = fixture
    fixture.workers(history)
    fixture.chat.handles.clear()
    const insert = db.db.prepare(`INSERT INTO remote_dispatch_attachments
    (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, terminal_handle, state,
      process_incarnation)
    VALUES (?, 'task', 'peer', 'epoch', ?, ?, 'ready', 'process-1')`)
    runLifecycleWriteTransaction(db.db, 'seed_quiet_notice', () => {
      for (let n = 0; n < history; n++) {
        insert.run(`stale-${n}`, `stale-pane-${n}`, `term_stale_${n}`)
      }
      if (working) {
        insert.run('live', 'live-pane', 'term_live')
        fixture.terminal('live-pane', 'term_live')
      }
    })
    let visited = 0
    db.db.function('quiet_visit', (_row: unknown) => {
      visited++
      return 1
    })
    const prepare = db.db.prepare.bind(db.db)
    vi.spyOn(db.db, 'prepare').mockImplementation((sql) =>
      prepare(
        sql
          .replace(
            /FROM dispatch_contexts\s+WHERE/g,
            'FROM dispatch_contexts WHERE quiet_visit(id) AND'
          )
          .replace(
            /FROM remote_dispatch_attachments\s+WHERE/g,
            'FROM remote_dispatch_attachments WHERE quiet_visit(dispatch_id) AND'
          )
      )
    )
    const local = vi.spyOn(db, 'getActiveDispatchForTerminal')
    const remote = vi.spyOn(db, 'findActiveRemoteAttachmentForPane')
    const observations = vi.fn(() => fixture.panes.keys())
    fixture.start({ readPaneKeys: observations })
    vi.advanceTimersByTime(120_000)
    // Three sweeps owe at most one dispatch seek and two attachment reads per working pane.
    expect(local).toHaveBeenCalledTimes(working * 3)
    expect(remote).toHaveBeenCalledTimes(working * 3)
    expect(visited).toBeLessThanOrEqual(working * 6)
    fixture.panes.clear()
    fixture.changes.notify()
    vi.advanceTimersByTime(60_000)
    local.mockClear()
    remote.mockClear()
    observations.mockClear()
    vi.advanceTimersByTime(600_000)
    expect(local).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
    expect(observations).not.toHaveBeenCalled()
  }
)

it('recovers acknowledged remote notices only for the current live process after restart', () => {
  const { db } = fixture
  fixture.terminal('remote-pane', 'term_remote')
  db.db
    .prepare(`INSERT INTO remote_dispatch_attachments
    (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, terminal_handle, state,
      process_incarnation)
    VALUES ('remote', 'task', 'peer', 'epoch', 'remote-pane', 'term_remote', 'ready', 'stale-process')`)
    .run()
  db.db.prepare("UPDATE remote_dispatch_attachments SET created_at = '1970-01-01 00:00:00'").run()
  fixture.start()
  vi.advanceTimersByTime(3_600_000)
  expect(db.db.prepare('SELECT count(*) AS n FROM federation_relay_items').get()?.n).toBe(0)
  db.db.prepare("UPDATE remote_dispatch_attachments SET process_incarnation = 'process-1'").run()
  fixture.changes.notify()
  vi.advanceTimersByTime(3_600_000)
  const first = db.db.prepare('SELECT message_id, payload FROM federation_relay_items').get()!
  expect(JSON.parse(String(first.payload)).type).toBe('status')
  expect(JSON.parse(JSON.parse(String(first.payload)).payload).quietNotice.ordinal).toBe(1)
  db.db.prepare("UPDATE federation_relay_items SET acked_at = datetime('now')").run()
  fixture.start()
  vi.advanceTimersByTime(7_140_000)
  expect(db.db.prepare('SELECT count(*) AS n FROM federation_relay_items').get()?.n).toBe(1)
  vi.advanceTimersByTime(60_000)
  const rows = db.db
    .prepare('SELECT message_id, payload FROM federation_relay_items ORDER BY sequence')
    .all()
  expect(rows).toHaveLength(2)
  expect(JSON.parse(JSON.parse(String(rows[1]!.payload)).payload).quietNotice.ordinal).toBe(2)
  expect(rows[1]!.message_id).not.toBe(first.message_id)
})

it.each([
  [0, 3_840_000],
  [1, 3_900_000]
])(
  'preserves a disconnected episode and budget with %i other working chats',
  (chats, reminderAt) => {
    const { run, workers } = fixture.workers(1 + chats)
    fixture.chat.handles.delete('term_worker_0')
    const pty = fixture.terminal(PANE, 'term_worker_0')
    fixture.store.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'work', agentType: 'codex' }
      },
      'ssh-owner'
    )
    expect(fixture.store.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      turnStartedAt: 0
    })
    const noticeTimes = () =>
      fixture.db
        .getUnreadRunMailbox(run.id, 100, ['status'])
        .map((message) => JSON.parse(message.payload!).quietNotice)
        .filter((notice) => notice.dispatchId === workers[0]!.id)
        .map((notice) => notice.observedAt)
    const inventory = vi.fn(() => fixture.panes.keys())
    fixture.start({ readPaneKeys: inventory })
    vi.advanceTimersByTime(960_000)
    expect(noticeTimes()).toEqual([900_000])
    fixture.panes.set(PANE, { ...pty, connected: false })
    inventory.mockClear()
    fixture.changes.notify(new Set(['status']))
    vi.advanceTimersByTime(1_200_000)
    expect(inventory).toHaveBeenCalledTimes(chats ? 20 : 1)
    fixture.panes.set(PANE, { ...pty, connected: true })
    fixture.changes.notify(new Set(['status']))
    vi.advanceTimersByTime(840_000)
    expect(noticeTimes()).toEqual([900_000])
    vi.advanceTimersByTime(960_000)
    expect(noticeTimes()).toEqual([900_000, reminderAt])
    fixture.panes.set(PANE, { ...pty, connected: false })
    fixture.changes.notify(new Set(['status']))
    vi.advanceTimersByTime(2_040_000)
    fixture.panes.set(PANE, { ...pty, connected: true })
    fixture.changes.notify(new Set(['status']))
    vi.advanceTimersByTime(7_200_000)
    expect(noticeTimes()).toEqual([900_000, reminderAt])
  }
)
