import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS } from './terminal-history-seed-chunks'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import type { DaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle & {
  emitData: (data: string) => void
} {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 999_999_999,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExit?.(0), 0)),
    forceKill: vi.fn(() => setTimeout(() => onExit?.(137), 0)),
    signal: vi.fn(),
    onData(callback) {
      onData = callback
    },
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData(data: string) {
      onData?.(data)
    }
  }
}

describe('DaemonPtyRouter history handoff', () => {
  let testDir: string
  let historyPath: string
  let legacyServer: DaemonServer
  let currentServer: DaemonServer
  let legacyAdapter: DaemonPtyAdapter
  let currentAdapter: DaemonPtyAdapter
  let router: DaemonPtyRouter
  let legacySubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'daemon-router-history-handoff-'))
    historyPath = join(testDir, 'history')
    const log: DaemonFileLog = { log: () => {}, close: () => {} }
    legacyServer = new DaemonServer({
      socketPath: getDaemonSocketPath(testDir, 29),
      tokenPath: join(testDir, 'legacy.token'),
      protocolVersion: 29,
      log,
      spawnSubprocess: () => {
        legacySubprocess = createMockSubprocess()
        return legacySubprocess
      }
    })
    currentServer = new DaemonServer({
      socketPath: getDaemonSocketPath(testDir, 30),
      tokenPath: join(testDir, 'current.token'),
      protocolVersion: 30,
      log,
      spawnSubprocess: createMockSubprocess
    })
    await Promise.all([legacyServer.start(), currentServer.start()])
    legacyAdapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(testDir, 29),
      tokenPath: join(testDir, 'legacy.token'),
      protocolVersion: 29,
      historyPath
    })
    currentAdapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(testDir, 30),
      tokenPath: join(testDir, 'current.token'),
      protocolVersion: 30,
      historyPath
    })
  })

  afterEach(async () => {
    if (router) {
      router.dispose()
    } else {
      legacyAdapter?.dispose()
      currentAdapter?.dispose()
    }
    await Promise.all([legacyServer?.shutdown(), currentServer?.shutdown()])
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('moves a slept v29 session to v30 with its full large history', async () => {
    const sessionId = 'large-legacy-session'
    const marker = 'V29-HISTORY-HANDOFF-MARKER'
    // Why: this fixture plays an OLD daemon binary, whose sessions retained ~5000 rows. New code
    // applies the flat window at session create, which would shrink the history below the chunked
    // seed threshold and silently skip the transfer path this test exists to cover.
    vi.stubEnv('ORCA_DAEMON_SESSION_SCROLLBACK_ROWS', '5000')
    await legacyAdapter.spawn({ sessionId, cols: 400, rows: 24 })
    legacySubprocess.emitData(`${'x'.repeat(TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS + 1)}${marker}`)
    // Keep only the played legacy session deep; the receiving daemon must use today's flat window.
    vi.stubEnv('ORCA_DAEMON_SESSION_SCROLLBACK_ROWS', String(DAEMON_SESSION_SCROLLBACK_ROWS))
    router = new DaemonPtyRouter({ current: currentAdapter, legacy: [legacyAdapter] })
    await router.discoverLegacySessions()
    const client = (
      currentAdapter as unknown as {
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
    ).client
    const request = vi.spyOn(client, 'request')

    await router.shutdown(sessionId, { immediate: true, keepHistory: true })
    const restored = await router.spawn({ sessionId, cols: 400, rows: 24 })

    expect(restored.coldRestore?.scrollback).toContain(marker)
    expect(request.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining([
        'startHistorySeedTransfer',
        'appendHistorySeedTransfer',
        'finishHistorySeedTransfer'
      ])
    )
    await expect(router.getBufferSnapshot(sessionId)).resolves.toBeNull()
    expect(currentAdapter.getHistoryManager()?.hasWriter(sessionId)).toBe(true)
  })
})
