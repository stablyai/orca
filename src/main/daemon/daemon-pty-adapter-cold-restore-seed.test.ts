/* Cold-restore seed transfer and the payload shapes handed back to the renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import { TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS } from './terminal-history-seed-chunks'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let lastSpawnOpts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
  } | null

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    lastSpawnOpts = null
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('history integration', () => {
    let historyDir: string
    let historyAdapter: DaemonPtyAdapter

    beforeEach(() => {
      historyDir = join(dir, 'history')
    })

    afterEach(async () => {
      historyAdapter?.dispose()
    })

    it('uploads a large cold-restore seed in bounded protocol chunks', async () => {
      const sessionId = 'chunked-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      const snapshotAnsi = `${'x'.repeat(TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS + 1)}\r\nCHUNKED-SEED-MARKER`
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/chunked',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-25T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(
        join(sessionDir, 'checkpoint.json'),
        JSON.stringify({
          snapshotAnsi,
          scrollbackAnsi: '',
          rehydrateSequences: '',
          cwd: '/projects/chunked',
          cols: 80,
          rows: 24,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: false
          },
          scrollbackLines: 0,
          generation: 0,
          checkpointedAt: '2026-07-25T10:00:00Z'
        })
      )
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const requestSpy = vi.spyOn(client, 'request')

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore?.scrollback).toContain('CHUNKED-SEED-MARKER')
      expect(requestSpy.mock.calls.map(([type]) => type)).toEqual(
        expect.arrayContaining([
          'startHistorySeedTransfer',
          'appendHistorySeedTransfer',
          'finishHistorySeedTransfer',
          'createOrAttach'
        ])
      )
      const createPayload = requestSpy.mock.calls.find(([type]) => type === 'createOrAttach')?.[1]
      expect(createPayload).toMatchObject({
        historySeedTransferId: expect.any(String)
      })
      expect(createPayload).not.toHaveProperty('historySeed')
      await expect(historyAdapter.getBufferSnapshot(sessionId)).resolves.toMatchObject({
        data: expect.stringContaining('CHUNKED-SEED-MARKER')
      })
    })

    it('keeps large recovery renderer-only with a preserved legacy daemon', async () => {
      await server.shutdown()
      server = new DaemonServer({
        socketPath,
        tokenPath,
        protocolVersion: 29,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()
      const sessionId = 'legacy-large-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      const checkpointPath = join(sessionDir, 'checkpoint.json')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/legacy',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-25T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(
        checkpointPath,
        JSON.stringify({
          snapshotAnsi: `${'x'.repeat(TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS + 1)}LEGACY-MARKER`,
          scrollbackAnsi: '',
          rehydrateSequences: '',
          cwd: '/projects/legacy',
          cols: 80,
          rows: 24,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: false
          },
          scrollbackLines: 0,
          generation: 0,
          checkpointedAt: '2026-07-25T10:00:00Z'
        })
      )
      historyAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion: 29,
        historyPath: historyDir
      })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const requestSpy = vi.spyOn(client, 'request')

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore?.scrollback).toContain('LEGACY-MARKER')
      expect(requestSpy.mock.calls.map(([type]) => type)).not.toContain('startHistorySeedTransfer')
      const createPayload = requestSpy.mock.calls.find(([type]) => type === 'createOrAttach')?.[1]
      expect(createPayload).not.toHaveProperty('historySeed')
      expect(createPayload).not.toHaveProperty('historySeedTransferId')
      expect(existsSync(checkpointPath)).toBe(true)
      const managerInternals = historyAdapter.getHistoryManager()! as unknown as {
        writers: Map<string, unknown>
      }
      expect(managerInternals.writers.has(sessionId)).toBe(false)
    })

    it('repairs legacy hostname UNC cwd for WSL spawn and cold-restore metadata', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const sessionId = 'wsl-legacy-cwd'
        const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(
          join(sessionDir, 'meta.json'),
          JSON.stringify({
            cwd: `\\\\${hostname()}\\home\\jin`,
            cols: 80,
            rows: 24,
            startedAt: '2026-04-15T10:00:00Z',
            endedAt: null,
            exitCode: null
          })
        )
        writeFileSync(join(sessionDir, 'scrollback.bin'), 'legacy WSL output\r\n')
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

        const result = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
          terminalWindowsWslDistro: 'Debian',
          sessionId
        })

        const repaired = '\\\\wsl.localhost\\Ubuntu\\home\\jin'
        expect(lastSpawnOpts?.cwd).toBe(repaired)
        expect(result.coldRestore?.cwd).toBe(repaired)
        expect(result.wslDistro).toBe('Ubuntu')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    it('returns cold restore OSC link ranges from checkpoint history', async () => {
      const sessionId = 'cold-restore-osc-links'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      const oscLinks = [{ row: 0, startCol: 0, endCol: 5, uri: 'https://example.com/issue/1234' }]
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(
        join(sessionDir, 'checkpoint.json'),
        JSON.stringify({
          snapshotAnsi: '#1234\r\n',
          scrollbackAnsi: '',
          oscLinks,
          rehydrateSequences: '',
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: false
          },
          scrollbackLines: 0,
          checkpointedAt: '2026-04-15T11:00:00Z'
        })
      )

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore?.oscLinks).toEqual(oscLinks)
    })

    it('cold-restores an alt-screen agent snapshot as scrollback on wake (hibernation)', async () => {
      // Why: hibernation force-kills the agent in alt-screen (empty scrollbackAnsi); fall back to the snapshot so the pane repaints instead of blanking.
      const sessionId = 'cold-restore-alt-screen'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(
        join(sessionDir, 'checkpoint.json'),
        JSON.stringify({
          snapshotAnsi: '\x1b[H Claude Code — Opus 4.8\r\n > ',
          scrollbackAnsi: '',
          oscLinks: [],
          rehydrateSequences: '\x1b[?1049h',
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: true
          },
          scrollbackLines: 0,
          generation: 0,
          checkpointedAt: '2026-04-15T11:00:00Z'
        })
      )

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('Claude Code')
      // The payload must NOT re-enter alt-screen — it would fight the relaunched agent's repaint and the renderer's POST_REPLAY_MODE_RESET.
      expect(result.coldRestore!.scrollback).not.toContain('\x1b[?1049h')
    })

    it('skips cold restore for an alt-screen session with an empty snapshot', async () => {
      // Why: alt-screen entered before any content → nothing to show; keep the no-op rather than fabricate a payload.
      const sessionId = 'cold-restore-alt-screen-empty'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(
        join(sessionDir, 'checkpoint.json'),
        JSON.stringify({
          snapshotAnsi: '',
          scrollbackAnsi: '',
          oscLinks: [],
          rehydrateSequences: '\x1b[?1049h',
          cwd: '/projects/myapp',
          cols: 80,
          rows: 24,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: true
          },
          scrollbackLines: 0,
          generation: 0,
          checkpointedAt: '2026-04-15T11:00:00Z'
        })
      )

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeUndefined()
    })
  })
})
