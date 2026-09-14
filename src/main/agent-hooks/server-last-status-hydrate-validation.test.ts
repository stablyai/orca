import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  buildBody,
  postHookEvent,
  recentTs,
  PANE,
  GOOD_PANE,
  OLD_PANE,
  FRESH_PANE,
  TAB_A_PANE,
  LEAF_2,
  LEAF_5
} from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Last-status persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-laststatus-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  it('treats a corrupt file as empty hydration without throwing', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(lastStatusPath(), 'not-json{{', 'utf8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      server.stop()
      warnSpy.mockRestore()
    }
  })

  it('drops hydrated metadata-only entries without a resumable Pi session', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            receivedAt,
            stateStartedAt: receivedAt,
            providerSessionOnly: true,
            providerSession: { key: 'session_id', id: 'pi-session-without-file' },
            payload: { state: 'done', prompt: '', agentType: 'pi' }
          }
        }
      }),
      'utf8'
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('last-status hydrate dropped 1 entries')
      )
    } finally {
      server.stop()
      warnSpy.mockRestore()
    }
  })

  it('rejects a stale version mismatch on hydrate', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 1,
        entries: {
          [PANE]: {
            paneKey: PANE,
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'old version', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('version mismatch'))
    } finally {
      server.stop()
      warnSpy.mockRestore()
    }
  })

  it('drops entries with malformed paneKeys but keeps valid ones', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          // Missing colon — drop.
          'no-colon': {
            paneKey: 'no-colon',
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'bad', agentType: 'claude' }
          },
          // Embedded paneKey mismatch — drop.
          [PANE]: {
            paneKey: makePaneKey('tab-x', LEAF_2),
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'mismatch', agentType: 'claude' }
          },
          // Valid.
          [GOOD_PANE]: {
            paneKey: GOOD_PANE,
            tabId: 'tab-good',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'survived', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: GOOD_PANE,
          payload: expect.objectContaining({ prompt: 'survived' })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('drops hydrate entries older than the TTL cutoff', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          // Stale — should be dropped.
          [OLD_PANE]: {
            paneKey: OLD_PANE,
            tabId: 'tab-old',
            receivedAt: eightDaysAgoMs,
            stateStartedAt: eightDaysAgoMs - 1000,
            payload: { state: 'done', prompt: 'old', agentType: 'claude' }
          },
          // Recent — should survive.
          [FRESH_PANE]: {
            paneKey: FRESH_PANE,
            tabId: 'tab-fresh',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'fresh', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const snapshot = server.getStatusSnapshot()
      expect(snapshot.map((e) => e.paneKey)).toEqual([FRESH_PANE])
    } finally {
      server.stop()
    }
  })

  it('hydrates registered legacy numeric pane keys as stable pane status entries', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          'tab-1:0': {
            paneKey: 'tab-1:0',
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-1:0', PANE)
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          state: 'working',
          prompt: 'legacy cached',
          agentType: 'claude'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('clears hydrated stable statuses when their persisted legacy alias PTY is cleared', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          'tab-1:0': {
            paneKey: 'tab-1:0',
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    const statusListener = vi.fn()
    server.registerPaneKeyAlias('tab-1:0', PANE, 'pty-1')
    server.subscribeStatusChanges(statusListener)
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toHaveLength(1)

      server.clearPaneKeyAliasesForPty('pty-1')

      expect(server.getStatusSnapshot()).toEqual([])
      expect(statusListener).toHaveBeenCalledWith([])
    } finally {
      server.stop()
    }
  })

  it('does not clear a stable status when alias cleanup no longer owns that pane', () => {
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-1:0', PANE, 'old-pty')
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    server.clearPaneKeyAliasesForPty('old-pty', { shouldClearStablePaneKey: () => false })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        agentType: 'claude'
      })
    ])
  })

  it('drops a hydrate entry whose tabId disagrees with the paneKey prefix', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [TAB_A_PANE]: {
            paneKey: TAB_A_PANE,
            // Why: paneKey says tab-A but entry claims tab-B; sanitizer must drop the inconsistent row, not hydrate it.
            tabId: 'tab-B',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'mismatch', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('clearPaneState evicts the entry from the on-disk file', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'about to drop' })
      )
      server.flushStatusPersistSync()
      let parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(parsed.entries[PANE]).toBeTruthy()

      server.clearPaneState(PANE)
      server.flushStatusPersistSync()
      parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(parsed.entries[PANE]).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('skips a write when the serialized contents are byte-identical to the previous write', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'first' })
      )
      server.flushStatusPersistSync()
      const firstMtime = statSync(lastStatusPath()).mtimeMs

      // Why: clearPaneState on a paneKey not in the cache must not trigger a redundant write (clear bails when nothing was evicted).
      server.clearPaneState(makePaneKey('non-existent', LEAF_5))
      server.flushStatusPersistSync()
      // Assert no rewrite happened: mtime unchanged after a forced sync flush.
      const secondMtime = statSync(lastStatusPath()).mtimeMs
      expect(secondMtime).toBe(firstMtime)
    } finally {
      server.stop()
    }
  })

  it('stop() flushes pending debounced writes synchronously', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'flush me' })
      )
      // Note: do NOT call flushStatusPersistSync explicitly — let stop() do it.
    } finally {
      server.stop()
    }
    // Why: stop() must synchronously drain the pending trailing-debounced timer even though we never explicitly flushed.
    expect(existsSync(lastStatusPath())).toBe(true)
    const parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
    expect(parsed.entries[PANE]?.payload?.prompt).toBe('flush me')
  })
})
