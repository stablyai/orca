import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'
import type {
  BinderSessionRow,
  OpenCodeSessionCursor
} from '../foreign-sqlite-readers/opencode-binder-sessions-result'
import { AgentHookServer } from './server'
import type { OpenCodeBinderLoopDeps } from './server/server-opencode-binder'

const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_A = makePaneKey('binder-a', LEAF_A)
const PANE_B = makePaneKey('binder-b', LEAF_B)
const DIR = '/tmp/binder-worktree-a'

class BinderTestServer extends AgentHookServer {
  public bindDeps(deps: Partial<OpenCodeBinderLoopDeps>): void {
    this._setOpenCodeBinderDepsForTests(deps)
  }

  public runBinderRound(): Promise<number> {
    return this.runOpenCodeBinderRoundOnce()
  }

  public startBinderLoop(): void {
    this.startOpenCodeBinderLoop()
  }

  public ingest(source: AgentHookSource, body: unknown): string | undefined {
    return this.normalizeLocalHookPayload(source, body).event?.paneKey
  }

  public readRegistry(sessionId: string): string | undefined {
    return lookupOpenCodeSessionPane(this._getStateForTests(), sessionId)?.paneKey
  }
}

const DB_PATH = '/tmp/binder-store/opencode.db'

/**
 * Stands in for the worker read: OpenCode 1 rows past the cursor, oldest first.
 * The SQL itself is covered by readers/opencode-binder-sessions.test.ts.
 */
class FakeSessionStore {
  rows: BinderSessionRow[] = []
  calls: { dbPath: string; cursor: OpenCodeSessionCursor }[] = []

  add(id = 'ses_live'): void {
    this.rows.push({ id, directory: DIR, createdAtMs: Date.now() - 60_000, parentId: null })
  }

  list = async (dbPath: string, cursor: OpenCodeSessionCursor): Promise<BinderSessionRow[]> => {
    this.calls.push({ dbPath, cursor })
    return this.rows
      .filter(
        (row) =>
          row.createdAtMs > cursor.ms || (row.createdAtMs === cursor.ms && row.id > cursor.id)
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))
  }
}

describe('opencode binder loop', () => {
  let store: FakeSessionStore
  let server: BinderTestServer

  beforeEach(() => {
    store = new FakeSessionStore()
    server = new BinderTestServer()
    server.bindDeps({
      now: () => Date.now(),
      dbPath: () => DB_PATH,
      listSessions: store.list,
      listPanes: () => [
        { paneKey: PANE_A, directory: DIR, worktreeId: `repo::${DIR}`, shellPid: 111 }
      ],
      sweep: async () => [
        {
          pid: 112,
          ppid: 111,
          startedAtMs: Date.now() - 120_000,
          executable: 'opencode',
          argv: ['opencode']
        }
      ]
    })
  })

  afterEach(() => {
    server.stop()
  })

  it('binds a fresh OpenCode 1 session to its pane', async () => {
    store.add()
    const applied = await server.runBinderRound()
    expect(applied).toBe(1)
    expect(server.readRegistry('ses_live')).toBe(PANE_A)
    expect(store.calls[0]).toEqual({ dbPath: DB_PATH, cursor: { ms: 0, id: '' } })
  })

  it('skips the round when the read answers its failure value', async () => {
    // [] is what the worker client resolves to on a timeout, crash or unreadable store.
    const sweep = vi.fn(async () => [])
    server.bindDeps({ listSessions: async () => [], sweep })
    expect(await server.runBinderRound()).toBe(0)
    expect(sweep).not.toHaveBeenCalled()
  })

  it('discards a round whose session read was in flight across stop', async () => {
    store.add()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const sweep = vi.fn(async () => [])
    server.bindDeps({
      sweep,
      listSessions: async (dbPath, cursor) => {
        await readGate
        return store.list(dbPath, cursor)
      }
    })
    const round = server.runBinderRound()
    server.stop()
    releaseRead()
    expect(await round).toBe(0)
    expect(sweep).not.toHaveBeenCalled()
    expect(server.readRegistry('ses_live')).toBeUndefined()

    // The stale round left the watermark alone: the next round lists from the start.
    server.bindDeps({ listSessions: store.list })
    expect(await server.runBinderRound()).toBe(0)
    expect(store.calls.at(-1)?.cursor).toEqual({ ms: 0, id: '' })
  })

  it('an opencode SessionStart kicks a round that binds before the poll', async () => {
    store.add()
    vi.useFakeTimers()
    try {
      // Birth arrives stamped with the wrong (server-starter) pane.
      server.ingest('opencode', {
        paneKey: PANE_B,
        launchToken: '',
        payload: { hook_event_name: 'SessionStart', sessionID: 'ses_live' }
      })
      expect(server.readRegistry('ses_live')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.readRegistry('ses_live')).toBe(PANE_A)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an OpenCode 2 SessionStart kicks no round', async () => {
    store.add()
    const sweep = vi.fn(async () => [])
    server.bindDeps({ sweep })
    vi.useFakeTimers()
    try {
      server.ingest('opencode', {
        paneKey: PANE_B,
        launchToken: '',
        opencodeMajor: 2,
        payload: { hook_event_name: 'SessionStart', sessionID: 'ses_live' }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sweep).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pane teardown unbinds its sessions', async () => {
    store.add()
    await server.runBinderRound()
    expect(server.readRegistry('ses_live')).toBe(PANE_A)
    server.clearPaneState(PANE_A)
    expect(server.readRegistry('ses_live')).toBeUndefined()
  })

  it('stops the loop without hanging the process', () => {
    store.add()
    expect(() => server.stop()).not.toThrow()
  })

  it('runs a round immediately on loop start', async () => {
    store.add()
    server.startBinderLoop()
    try {
      await vi.waitFor(() => expect(server.readRegistry('ses_live')).toBe(PANE_A))
    } finally {
      server.stop()
    }
  })

  it('discards a round that was in flight across stop', async () => {
    store.add()
    let releaseSweep!: () => void
    const sweepGate = new Promise<void>((resolve) => {
      releaseSweep = resolve
    })
    server.bindDeps({
      sweep: async () => {
        await sweepGate
        return [
          {
            pid: 112,
            ppid: 111,
            startedAtMs: Date.now() - 120_000,
            executable: 'opencode',
            argv: ['opencode']
          }
        ]
      }
    })
    const round = server.runBinderRound()
    server.stop()
    releaseSweep()
    expect(await round).toBe(0)
    expect(server.readRegistry('ses_live')).toBeUndefined()
  })

  it('an obsolete round does not clear the new round running flag', async () => {
    store.add()
    let releaseFirst!: () => void
    let releaseLater!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const laterGate = new Promise<void>((resolve) => {
      releaseLater = resolve
    })
    const clientRow = {
      pid: 112,
      ppid: 111,
      startedAtMs: Date.now() - 120_000,
      executable: 'opencode',
      argv: ['opencode']
    }
    let sweepCalls = 0
    server.bindDeps({
      sweep: async () => {
        sweepCalls += 1
        await (sweepCalls === 1 ? firstGate : laterGate)
        return [clientRow]
      }
    })
    server.startBinderLoop()
    await vi.waitFor(() => expect(sweepCalls).toBe(1))
    server.stop()
    server.startBinderLoop()
    await vi.waitFor(() => expect(sweepCalls).toBe(2))
    // The obsolete round finishes while the new round is still parked: its
    // finally must not clear the flag the new round holds.
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // A third round attempted now must be refused at the flag check, calling
    // no sweep. With the unguarded finally it would be admitted instead.
    const extraRound = server.runBinderRound()
    expect(sweepCalls).toBe(2)
    releaseLater()
    await vi.waitFor(() => expect(server.readRegistry('ses_live')).toBe(PANE_A))
    await extraRound
    server.stop()
  })
})

// OpenCode 1 `serve` in pane A stamps every post with pane A; `attach` in pane B drives the session.
describe('OpenCode 1 serve + attach', () => {
  let server: BinderTestServer

  beforeEach(() => {
    const store = new FakeSessionStore()
    store.add()
    const startedAtMs = Date.now() - 120_000
    server = new BinderTestServer()
    server.bindDeps({
      now: () => Date.now(),
      dbPath: () => DB_PATH,
      listSessions: store.list,
      listPanes: () => [
        { paneKey: PANE_A, directory: DIR, worktreeId: `repo::${DIR}`, shellPid: 111 },
        { paneKey: PANE_B, directory: DIR, worktreeId: `repo::${DIR}`, shellPid: 211 }
      ],
      sweep: async () => [
        { pid: 112, ppid: 111, startedAtMs, executable: 'opencode', argv: ['opencode', 'serve'] },
        {
          pid: 212,
          ppid: 211,
          startedAtMs,
          executable: 'opencode',
          argv: ['opencode', 'attach', 'http://127.0.0.1:4096']
        }
      ]
    })
  })

  afterEach(() => {
    server.stop()
  })

  const busy = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    paneKey: PANE_A,
    launchToken: '',
    ...extra,
    payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_live' }
  })

  it("reports the session on the attaching pane, not the server's", async () => {
    expect(await server.runBinderRound()).toBe(1)
    expect(server.ingest('opencode', busy())).toBe(PANE_B)
  })

  it('never moves an OpenCode 2 post with the same shape', async () => {
    await server.runBinderRound()
    expect(server.ingest('opencode', busy({ opencodeMajor: 2 }))).toBe(PANE_A)
  })
})
