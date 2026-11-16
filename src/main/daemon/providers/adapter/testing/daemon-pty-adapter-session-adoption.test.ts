import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from '../../../transport/client/daemon-client'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonServer } from '../../../server/daemon-server'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'
import type { DaemonFileLog } from '../../../observability/daemon-file-log'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
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
  let lastSpawnOpts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
  } | null
  let daemonLog: DaemonFileLog

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
    daemonLog = harness.daemonLog
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

  describe('spawn with sessionId (reattach)', () => {
    it('returns full snapshot and isReattach when reattaching', async () => {
      const sessionId = 'reattach-test-session'
      const first = await adapter.spawn({ cols: 80, rows: 24, sessionId, launchAgent: 'droid' })
      expect(first.id).toBe(sessionId)
      expect(first.isReattach).toBeUndefined()
      expect(first.launchAgent).toBe('droid')

      lastSubprocess._simulateData('hello from shell\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const second = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.id).toBe(sessionId)
      expect(second.isReattach).toBe(true)
      expect(second.launchAgent).toBe('droid')
      expect(second.snapshot).toBeDefined()
      expect(second.snapshot).toContain('hello from shell')
      expect(second.providerSequence).toEqual({
        value: 'hello from shell\r\n'.length,
        generation: 'continued'
      })
    })

    it('forwards attach-only and never creates an absent stable session', async () => {
      const subprocessBeforeAttach = lastSubprocess
      await expect(
        adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'missing-stable-pane-session',
          attachOnly: true
        })
      ).rejects.toThrow('Session not found: missing-stable-pane-session')
      expect(lastSubprocess).toBe(subprocessBeforeAttach)
    })

    it('retires a replacement created by a raced-out v30 stable pane', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockResolvedValueOnce({
          isNew: true,
          snapshot: null,
          pid: 4321,
          shellState: 'unsupported',
          incarnationId: 'legacy-replacement-incarnation'
        })
        .mockResolvedValueOnce({})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(
          legacy.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'raced-out-legacy-session',
            attachOnly: true,
            command: 'must-not-run'
          })
        ).rejects.toThrow('Session not found: raced-out-legacy-session')
        expect(request).toHaveBeenNthCalledWith(
          1,
          'createOrAttach',
          expect.objectContaining({ command: undefined })
        )
        expect(request).toHaveBeenNthCalledWith(2, 'kill', {
          sessionId: 'raced-out-legacy-session',
          immediate: true
        })
        expect(legacy.getActiveSessionIds()).toEqual([])
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })
  })

  describe('attach', () => {
    it('preserves the live session dimensions instead of forcing 80×24', async () => {
      const { id } = await adapter.spawn({ cols: 137, rows: 41 })

      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      await adapter2.attach(id)

      expect(lastSubprocess.resize).not.toHaveBeenCalled()
      expect(await adapter2.getAppliedSize(id)).toEqual({ cols: 137, rows: 41 })
      adapter2.dispose()
    })

    it('refuses an attach whose exit event beats the control reply', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const exits: string[] = []
      adapter2.onExit(({ id: exitedId }) => exits.push(exitedId))
      const client = (
        adapter2 as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const request = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        const result = await request(type, payload)
        if (type === 'createOrAttach') {
          lastSubprocess._simulateExit(0)
          await waitFor(() => exits.includes(id))
        }
        return result
      })

      try {
        await expect(adapter2.attach(id)).rejects.toThrow(`Session not found: ${id}`)
        expect(adapter2.getActiveSessionIds()).toEqual([])
      } finally {
        adapter2.dispose()
      }
    })

    it('refuses to create when the session is absent (attach-only)', async () => {
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })

      await expect(adapter2.attach('wt-x@@deadbeef')).rejects.toThrow(
        'Session not found: wt-x@@deadbeef'
      )

      expect(lastSpawnOpts).toBeNull()
      adapter2.dispose()
    })

    it('retires a fresh session returned by a current daemon for attach-only', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 100, rows: 30 } } as never)
            : type === 'createOrAttach'
              ? ({ isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never)
              : ({} as never)
        )
      const current = new DaemonPtyAdapter({ socketPath, tokenPath })
      try {
        await expect(current.attach('raced-current-session')).rejects.toThrow(
          'Session not found: raced-current-session'
        )

        expect(requestSpy).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({ cols: 100, rows: 30, attachOnly: true })
        )
        expect(requestSpy).toHaveBeenCalledWith('kill', {
          sessionId: 'raced-current-session',
          immediate: true
        })
        expect(current.getActiveSessionIds()).toEqual([])
      } finally {
        current.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('keeps a failed retire of the accidental legacy spawn unverifiable', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) => {
          if (type === 'getSize') {
            return { size: { cols: 100, rows: 30 } } as never
          }
          if (type === 'createOrAttach') {
            return { isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never
          }
          throw new Error('kill transport lost')
        })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('orphaned-legacy-session')).rejects.toBeInstanceOf(
          TerminalSessionOwnerUnverifiedError
        )

        expect(warnSpy).toHaveBeenCalledWith(
          '[daemon] attach-only retire of unexpected spawn failed',
          expect.objectContaining({ sessionId: 'orphaned-legacy-session' })
        )
      } finally {
        legacy.dispose()
        warnSpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })
  })

  describe('listProcesses', () => {
    it('target reads neither validate unrelated rows nor retire omitted active sessions', async () => {
      const first = await adapter.spawn({ cols: 80, rows: 24 })
      const second = await adapter.spawn({ cols: 80, rows: 24 })
      // Full inventory must retain the exact same active-session census after a partial lookup.
      const full = await adapter.listProcesses()
      const selected = await adapter.listProcesses({ ptyIds: [first.id], targetOwnerOnly: true })
      expect(selected.map((row) => row.id)).toEqual([first.id])
      expect(adapter.hasPty(second.id)).toBe(true)
      expect((await adapter.listProcesses()).map((row) => row.id).sort()).toEqual(
        full.map((row) => row.id).sort()
      )
    })

    it('reports no title, since a made-up one would read as the terminal’s own', async () => {
      await adapter.spawn({ cols: 80, rows: 24 })

      expect((await adapter.listProcesses()).map((row) => row.title)).toEqual([''])
    })

    // Reconcile missed disconnect-time exits so cached hasPty results cannot block absence proofs.
    it('drops cached session ids an authoritative inventory omits', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const staleId = 'repo::/repo/stale@@deadbeef'
      ;(adapter as unknown as { activeSessionIds: Set<string> }).activeSessionIds.add(staleId)
      expect(adapter.hasPty(staleId)).toBe(true)

      await adapter.listProcesses()

      expect(adapter.hasPty(staleId)).toBe(false)
      expect(adapter.hasPty(id)).toBe(true)
    })

    it('retains authenticated identity and reports replacement across a same-endpoint reconnect', async () => {
      await adapter.listProcesses()
      const firstIdentity = adapter.getLastAuthenticatedDaemonIdentity()
      expect(firstIdentity).not.toBeNull()
      const identityChanges: {
        previous: NonNullable<typeof firstIdentity>
        current: NonNullable<typeof firstIdentity>
      }[] = []
      adapter.onDaemonIdentityChanged(() => {
        throw new Error('audit listener failed')
      })
      adapter.onDaemonIdentityChanged((event) => identityChanges.push(event))

      await server.shutdown()
      await waitFor(
        () => !(adapter as unknown as { client: { isConnected(): boolean } }).client.isConnected()
      )
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(firstIdentity)
      server = new DaemonServer({
        socketPath,
        tokenPath,
        launchNonce: 'replacement-launch',
        startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
        log: daemonLog,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()

      await expect(adapter.listProcesses()).resolves.toEqual([])

      expect(identityChanges).toEqual([
        {
          previous: firstIdentity,
          current: {
            pid: process.pid,
            startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
            launchNonce: 'replacement-launch'
          }
        }
      ])
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(identityChanges[0]?.current)
    })
  })

  describe('killed-session tombstones', () => {
    it('prevents spawn after shutdown for same sessionId', async () => {
      const sessionId = 'tombstone-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId })).rejects.toThrow(
        'was explicitly killed'
      )
    })
  })
})
