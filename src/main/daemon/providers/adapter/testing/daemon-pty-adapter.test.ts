import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import type { DaemonServer } from '../../../server/daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from '../../../health/daemon-health'
import type * as DaemonTccAttributionModule from '../../../permissions/daemon-tcc-attribution'
import type * as DaemonBundleStalenessModule from '../../../launch/daemon-bundle-staleness'

const {
  getMacDaemonSystemResolverHealthMock,
  getMacDaemonTccAttributionHealthMock,
  isDaemonStaleForCurrentBundleMock
} = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(
    async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
  ),
  getMacDaemonTccAttributionHealthMock: vi.fn(
    async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
  ),
  isDaemonStaleForCurrentBundleMock: vi.fn(async () => false)
}))

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

vi.mock('../../../launch/daemon-bundle-staleness', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonBundleStalenessModule>()
  return {
    ...actual,
    isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock
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
  let daemonLogEvents: string[]

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
    daemonLogEvents = harness.daemonLogEvents
    lastSpawnOpts = null
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
    isDaemonStaleForCurrentBundleMock.mockReset()
    isDaemonStaleForCurrentBundleMock.mockResolvedValue(false)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn', () => {
    it('carries classified startup spans from the daemon source to the adapter', async () => {
      const onData = vi.fn()
      adapter.onData(onData)
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      const query = '\x1b]10;?\x07'
      lastSubprocess._simulateData(query)
      lastSubprocess._simulateData('prompt')

      await waitFor(() => onData.mock.calls.length >= 2)

      expect(lastSubprocess.write).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
      expect(onData).toHaveBeenCalledWith({
        id,
        data: '',
        sequenceChars: query.length,
        seq: query.length,
        transformed: true
      })
      expect(onData).toHaveBeenCalledWith({ id, data: 'prompt' })
      await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
        data: expect.not.stringContaining(']10;rgb')
      })
    })

    it('does not republish adapter state when stream exit beats the create reply', async () => {
      const sessionId = 'exit-before-create-reply'
      const exits: { id: string; incarnationId?: string }[] = []
      adapter.onExit((payload) => exits.push(payload))
      const client = (
        adapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          const exitCount = exits.length
          lastSubprocess._simulateExit(0)
          await waitFor(() => exits.length === exitCount + 1)
        }
        return response
      })

      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(exits).toHaveLength(2)
      expect(exits[0]?.incarnationId).toBeDefined()
      expect(exits[1]?.incarnationId).toBeDefined()
      expect(exits[1]?.incarnationId).not.toBe(exits[0]?.incarnationId)
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        pendingSpawnOperationsBySessionId: Map<string, unknown>
      }
      expect(internals.activeSessionIds.has(sessionId)).toBe(false)
      expect(internals.sessionIncarnations.has(sessionId)).toBe(false)
      expect(internals.pendingSpawnOperationsBySessionId.has(sessionId)).toBe(false)
    })

    it('does not republish an adopted canonical id when its exit beats the reply', async () => {
      const claim = {
        digestVersion: 1 as const,
        keyId: 'key',
        identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent: 'codex' as const
      }
      const surface = {
        worktreeId: 'worktree',
        tabId: 'tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_claimed'
      }
      const canonicalId = 'canonical-claimed-session'
      const first = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: canonicalId,
        agentSessionEnsure: { claim, surface }
      })
      expect(first.agentSessionEnsure?.disposition).toBe('created')

      const exits: { id: string; incarnationId?: string }[] = []
      adapter.onExit((payload) => exits.push(payload))
      const client = (
        adapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          const exitCount = exits.length
          lastSubprocess._simulateExit(0)
          await waitFor(() => exits.length === exitCount + 1)
        }
        return response
      })

      const adopted = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'different-requested-session',
        agentSessionEnsure: {
          claim,
          surface: { ...surface, terminalHandle: 'term_retry' }
        }
      })

      expect(adopted.id).toBe(canonicalId)
      expect(adopted.agentSessionEnsure?.disposition).toBe('adopted')
      expect(adapter.didExitBeforeSpawnReply(adopted)).toBe(true)
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        pendingSpawnOperationsBySessionId: Map<string, unknown>
        pendingClaimSpawnOperations: Set<unknown>
      }
      expect(internals.activeSessionIds.has(canonicalId)).toBe(false)
      expect(internals.sessionIncarnations.has(canonicalId)).toBe(false)
      expect(internals.pendingSpawnOperationsBySessionId.has('different-requested-session')).toBe(
        false
      )
      expect(internals.pendingClaimSpawnOperations.size).toBe(0)
    })

    it('does not dispatch createOrAttach when cancellation wins during preflight', async () => {
      let finishPreflight: (() => void) | undefined
      const preflight = new Promise<void>((resolve) => {
        finishPreflight = resolve
      })
      const internals = adapter as unknown as {
        ensureConnected(): Promise<void>
        client: { request: (...args: unknown[]) => Promise<unknown> }
      }
      const ensureConnected = vi
        .spyOn(internals, 'ensureConnected')
        .mockImplementation(() => preflight)
      const request = vi.spyOn(internals.client, 'request')
      const abort = new AbortController()

      const spawning = adapter.spawn({ cols: 80, rows: 24, signal: abort.signal })
      await waitFor(() => ensureConnected.mock.calls.length === 1)
      abort.abort()
      finishPreflight?.()

      await expect(spawning).rejects.toThrow('client_disconnected')
      expect(request).not.toHaveBeenCalledWith('createOrAttach', expect.anything())
    })

    it('keeps a reattached native UNC session native despite a conflicting WSL preference', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const sessionId = 'native-conflicting-wsl-attach'
        const created = await adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId,
          cwd: '\\\\server\\share\\repo',
          shellOverride: 'powershell.exe'
        })
        const attached = await adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId,
          cwd: 'C:\\repo',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        })

        expect(created.wslDistro).toBeNull()
        expect(attached.wslDistro).toBeNull()
        expect(attached.isReattach).toBe(true)
        expect(lastSpawnOpts?.cwd).toBe('\\\\server\\share\\repo')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })
  })

  describe('getAppliedSize', () => {
    it('does not advance when a resize is dropped after the session exited', async () => {
      const { id } = await adapter.spawn({ cols: 200, rows: 50 })

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      adapter.resize(id, 80, 24)
      await new Promise((r) => setTimeout(r, 50))

      expect(lastSubprocess.resize).not.toHaveBeenCalledWith(80, 24)
      const applied = await adapter.getAppliedSize(id)
      expect(applied?.cols).not.toBe(80)
    })
  })

  describe('getBufferSnapshot', () => {
    it('publishes shell ownership only after the daemon proves the live PTY tree', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess.confirmShellForeground.mockResolvedValue(true)

      lastSubprocess._simulateData(
        '\x1b[?1049h\x1b[?1003h\x1b[?1006hTUI\x1b]133;D;137\x07shell-marker'
      )

      await vi.waitFor(async () => {
        await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
          alternateScreen: false,
          terminalOwner: 'shell'
        })
      })
      await expect(adapter.confirmShellForeground(id)).resolves.toBe(true)
      expect(lastSubprocess.confirmShellForeground).toHaveBeenCalledTimes(1)
    })

    it('preserves live TUI modes when the daemon cannot prove shell ownership', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      lastSubprocess._simulateData(
        '\x1b[?1049h\x1b[?1003h\x1b[?1006hLIVE-TUI\x1b]133;D;0\x07nested-shell'
      )

      await vi.waitFor(() => expect(lastSubprocess.confirmShellForeground).toHaveBeenCalledTimes(1))
      const snapshot = await adapter.getBufferSnapshot(id)
      expect(snapshot?.alternateScreen).toBe(true)
      expect(snapshot?.terminalOwner).toBeUndefined()
    })

    it('returns the daemon model with its absolute stream sequence', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('complete hidden output\r\n')

      const snapshot = await adapter.getBufferSnapshot(id, { scrollbackRows: 123 })

      expect(snapshot).toMatchObject({
        data: expect.stringContaining('complete hidden output'),
        cols: 80,
        rows: 24,
        seq: 'complete hidden output\r\n'.length,
        source: 'headless'
      })
    })

    // Known zero proves no kitty flags were negotiated; absence leaves the state unknown.
  })

  describe('shutdown', () => {
    it('kills a live session from a fresh adapter that has not connected yet', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      const freshAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      try {
        await freshAdapter.shutdown(id, { immediate: true })
      } finally {
        freshAdapter.dispose()
      }
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
      await expect(adapter.listProcesses()).resolves.not.toContainEqual(
        expect.objectContaining({ id })
      )
    })

    it('coalesces the lazy connection when a fresh adapter shuts down concurrent sessions', async () => {
      const ids = await Promise.all(
        ['concurrent-kill-a', 'concurrent-kill-b'].map(async (sessionId) =>
          adapter.spawn({ cols: 80, rows: 24, sessionId }).then((result) => result.id)
        )
      )
      const freshAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      daemonLogEvents.length = 0

      try {
        await Promise.all(ids.map((id) => freshAdapter.shutdown(id, { immediate: true })))
      } finally {
        freshAdapter.dispose()
      }

      await expect(adapter.listProcesses()).resolves.toEqual([])
      expect(daemonLogEvents.filter((event) => event === 'client-hello-accepted')).toHaveLength(2)
    })
  })

  describe('onExit', () => {
    it('does not let an untagged stale-write exit clear a known replacement', async () => {
      // Stale fire-and-forget writes receive compatibility exits without incarnation IDs.
      await adapter.spawn({ cols: 80, rows: 24 })
      const sessionId = 'replacement-known-before-untagged-exit'
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        client: { onEvent: (listener: (event: unknown) => void) => () => void }
      }
      internals.activeSessionIds.add(sessionId)
      internals.sessionIncarnations.set(sessionId, 'incarnation-new')

      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))
      const rawEvents: unknown[] = []
      const removeRawListener = internals.client.onEvent((event) => rawEvents.push(event))
      try {
        expect(adapter.write(sessionId, 'stale-input')).toBe(true)
        await waitFor(() =>
          rawEvents.some(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              (event as { event?: string }).event === 'exit'
          )
        )
      } finally {
        removeRawListener()
      }

      expect(exits).toEqual([])
      expect(internals.activeSessionIds.has(sessionId)).toBe(true)
      expect(internals.sessionIncarnations.get(sessionId)).toBe('incarnation-new')
    })
  })

  describe('dispose', () => {
    it('disconnects without killing sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      adapter.dispose()

      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const procs = await adapter2.listProcesses()
      expect(procs).toHaveLength(1)
      adapter2.dispose()
    })
  })
})
