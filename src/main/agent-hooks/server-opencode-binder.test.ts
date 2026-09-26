import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'
import SyncDatabase from '../sqlite/sync-database'
import { AgentHookServer } from './server'
import type { OpenCodeBinderLoopDeps } from './server/server-opencode-binder'
import { defaultOpenCodeDbPath, listOpenCodeDbSessions } from '../opencode/opencode-session-binder'

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

  public ingest(source: AgentHookSource, body: unknown): void {
    this.normalizeLocalHookPayload(source, body)
  }

  public readRegistry(sessionId: string): string | undefined {
    return lookupOpenCodeSessionPane(this._getStateForTests(), sessionId)?.paneKey
  }
}

function writeDb(dbPath: string, table: 'session_v2' | 'session'): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, parent_id TEXT)`
    )
    const insert = db.prepare(
      `INSERT INTO ${table} (id, directory, time_created, parent_id) VALUES (?, ?, ?, ?)`
    )
    insert.run('ses_live', DIR, Date.now() - 60_000, null)
  } finally {
    db.close()
  }
}

describe('opencode binder loop', () => {
  let dir = ''
  let dbPath = ''
  let server: BinderTestServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'binder-db-'))
    dbPath = join(dir, 'opencode.db')
    server = new BinderTestServer()
    server.bindDeps({
      now: () => Date.now(),
      dbPath: () => dbPath,
      listPanes: () => [
        {
          paneKey: PANE_A,
          directory: DIR,
          worktreeId: `repo::${DIR}`,
          shellPid: 111,
          lastInputAtMs: null,
          previousInputAtMs: null
        }
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
    rmSync(dir, { recursive: true, force: true })
  })

  it('binds a fresh session to its pane', async () => {
    writeDb(dbPath, 'session_v2')
    const applied = await server.runBinderRound()
    expect(applied).toBe(1)
    expect(server.readRegistry('ses_live')).toBe(PANE_A)
  })

  it('falls back to the v1 session table', async () => {
    writeDb(dbPath, 'session')
    const applied = await server.runBinderRound()
    expect(applied).toBe(1)
    expect(server.readRegistry('ses_live')).toBe(PANE_A)
  })

  it('an opencode SessionStart kicks a round that binds before the poll', async () => {
    writeDb(dbPath, 'session_v2')
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

  it('pane teardown unbinds its sessions', async () => {
    writeDb(dbPath, 'session_v2')
    await server.runBinderRound()
    expect(server.readRegistry('ses_live')).toBe(PANE_A)
    server.clearPaneState(PANE_A)
    expect(server.readRegistry('ses_live')).toBeUndefined()
  })

  it('stops the loop without hanging the process', () => {
    writeDb(dbPath, 'session_v2')
    expect(() => server.stop()).not.toThrow()
  })

  it('runs a round immediately on loop start', async () => {
    writeDb(dbPath, 'session_v2')
    server.startBinderLoop()
    try {
      await vi.waitFor(() => expect(server.readRegistry('ses_live')).toBe(PANE_A))
    } finally {
      server.stop()
    }
  })

  it('discards a round that was in flight across stop', async () => {
    writeDb(dbPath, 'session_v2')
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
    writeDb(dbPath, 'session_v2')
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

describe('listOpenCodeDbSessions', () => {
  let dir = ''
  let dbPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'binder-reader-'))
    dbPath = join(dir, 'opencode.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads session_v2 rows newer than the watermark', () => {
    writeDb(dbPath, 'session_v2')
    const rows = listOpenCodeDbSessions(dbPath, { ms: 0, id: '' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'ses_live', directory: DIR, parentId: null })
    expect(listOpenCodeDbSessions(dbPath, { ms: Date.now(), id: '' })).toEqual([])
  })

  it('returns [] for a missing database instead of throwing', () => {
    expect(listOpenCodeDbSessions(join(dir, 'absent.db'), { ms: 0, id: '' })).toEqual([])
  })

  it('the default path points at the local opencode store', () => {
    expect(defaultOpenCodeDbPath()).toMatch(/opencode\.db$/)
  })
})

describe('binder registry isolation', () => {
  it('a fresh listener state starts unbound', () => {
    const state = createHookListenerState()
    expect(lookupOpenCodeSessionPane(state, 'ses_live')).toBeUndefined()
  })
})
