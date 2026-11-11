import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonServer } from '../../../server/daemon-server'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import { TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS } from '../../../history/seed-transfer/terminal-history-seed-chunks'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from '../../../health/daemon-health'
import type * as DaemonTccAttributionModule from '../../../permissions/daemon-tcc-attribution'

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

vi.mock('../../../health/daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('../../../permissions/daemon-tcc-attribution', async (importOriginal) => {
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

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
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
        spawnSubprocess: () => {
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
  })
})
