/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonProtocolError } from './daemon-errors'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { HeadlessEmulator } from './headless-emulator'
import { getHistorySessionDirName } from './history-paths'
import type { HistoryReader } from './history-reader'
import type { SubprocessHandle } from './session'
import type { DaemonFileLog } from './daemon-file-log'
import type * as DaemonHealthModule from './daemon-health'
import { getDaemonSocketPath } from './daemon-spawner'

const { getMacDaemonSystemResolverHealthMock } = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(async () => 'unknown')
}))

const itOnPosix = process.platform === 'win32' ? it.skip : it

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-adapter-test-'))
}

function createMockSubprocess(dataOnSubscribe?: string): SubprocessHandle & {
  pause: ReturnType<typeof vi.fn<() => void>>
  resume: ReturnType<typeof vi.fn<() => void>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    // Why: getCwd falls back to OS pid lookup; an implausibly-high fake pid can't collide with a real process' cwd.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
      if (dataOnSubscribe) {
        cb(dataOnSubscribe)
      }
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

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
  let subprocessDataOnSubscribe: string | undefined
  let daemonLog: DaemonFileLog
  let daemonLogEvents: string[]

  beforeEach(async () => {
    subprocessDataOnSubscribe = undefined
    dir = createTestDir()
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')

    daemonLogEvents = []
    daemonLog = {
      log: (event) => daemonLogEvents.push(event),
      close() {}
    }
    server = new DaemonServer({
      socketPath,
      tokenPath,
      log: daemonLog,
      spawnSubprocess: (opts) => {
        lastSpawnOpts = opts
        lastSubprocess = createMockSubprocess(subprocessDataOnSubscribe)
        return lastSubprocess
      }
    })
    await server.start()

    adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    lastSpawnOpts = null
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn', () => {
    it('returns a result with an id', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
    })

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

    it('omits startup intent and close control for the preserved v23 protocol', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: true,
        pid: null,
        shellState: 'unsupported',
        snapshot: null
      } as never)
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 23 })
      try {
        await legacy.spawn({
          sessionId: 'legacy-session',
          cols: 80,
          rows: 24,
          startupIngress: {
            colors: { foreground: '#2e3434', background: '#ffffff' },
            deadlineMs: 5_000
          }
        })
        const createPayload = requestSpy.mock.calls.find(([type]) => type === 'createOrAttach')?.[1]
        expect(createPayload).not.toHaveProperty('startupIngress')
        await expect(legacy.closeStartupQueryAuthority('legacy-session')).resolves.toBe(0)
        expect(requestSpy).not.toHaveBeenCalledWith('closeStartupQueryAuthority', expect.anything())
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('uses worktreeId as session prefix when provided', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      expect(result.id).toContain('wt-1')
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

    itOnPosix('keeps plain Codex startup on the short daemon shell-ready timeout', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        env: { SHELL: '/bin/zsh' }
      })

      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledWith('codex\n')
    })

    itOnPosix('waits for shell-ready for delivery-hinted Codex startup', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready',
        env: { SHELL: '/bin/zsh' }
      })

      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(lastSubprocess.write).not.toHaveBeenCalled()

      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07')
      lastSubprocess._simulateData('\r\nuser@host $ ')

      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
    })
  })

  describe('write', () => {
    it('sends data to the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.write(id, 'ls\n')

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.write).toHaveBeenCalledWith('ls\n')
    })
  })

  describe('resize', () => {
    it('resizes the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.resize(id, 120, 40)

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('producer flow control', () => {
    it('routes pausePty/resumePty notifications to the daemon session subprocess', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      adapter.pauseProducer(id)
      await waitFor(() => lastSubprocess.pause.mock.calls.length > 0)

      adapter.resumeProducer(id)
      await waitFor(() => lastSubprocess.resume.mock.calls.length > 0)
    })

    it('sends pause/resume as fire-and-forget notifications on the current protocol', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        adapter.pauseProducer(id)
        adapter.resumeProducer(id)
        expect(notifySpy).toHaveBeenCalledWith('pausePty', { sessionId: id })
        expect(notifySpy).toHaveBeenCalledWith('resumePty', { sessionId: id })
      } finally {
        notifySpy.mockRestore()
      }
    })

    it('never sends pause/resume notifications on a legacy protocol version', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 18 })
      try {
        legacy.pauseProducer('legacy-session')
        legacy.resumeProducer('legacy-session')
        expect(notifySpy).not.toHaveBeenCalled()
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
      }
    })

    it('owes paused sessions a resumePty on the next connect after a socket drop', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.pauseProducer(id)
      await waitFor(() => lastSubprocess.pause.mock.calls.length > 0)

      // Drop the daemon out from under the adapter: the in-flight pause now has no matching resume.
      await server.shutdown()
      await waitFor(() => !(adapter as unknown as { client: DaemonClient }).client.isConnected())

      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()

      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        // Any reconnecting operation must flush the owed resume first.
        await adapter.listProcesses()
        expect(notifySpy).toHaveBeenCalledWith('resumePty', { sessionId: id })
      } finally {
        notifySpy.mockRestore()
      }
    })
  })

  describe('background stream thinning compatibility', () => {
    it('reports authoritative snapshot support only for protocol v20 and newer', () => {
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 19 })
      try {
        expect(legacy.canProvideAuthoritativeBufferSnapshot('legacy-session')).toBe(false)
        expect(adapter.canProvideAuthoritativeBufferSnapshot('current-session')).toBe(true)
      } finally {
        legacy.dispose()
      }
    })

    it('reports background state on the authoritative-snapshot protocol', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        adapter.setPtyBackgrounded('current-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'current-session',
          background: true
        })
      } finally {
        notifySpy.mockRestore()
      }
    })

    it('keeps preserved v19 sessions unthinned because their snapshots have no sequence', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 19 })
      try {
        legacy.setPtyBackgrounded('legacy-session', true)
        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'legacy-session',
          background: false
        })
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
      }
    })

    it('clears a preserved v19 background hint before attaching its stream', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: true,
        pid: null,
        shellState: 'unsupported',
        snapshot: null
      } as never)
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 19 })
      try {
        await legacy.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

        expect(notifySpy).toHaveBeenCalledWith('setSessionBackground', {
          sessionId: 'legacy-session',
          background: false
        })
        expect(notifySpy.mock.invocationCallOrder[0]).toBeLessThan(
          requestSpy.mock.invocationCallOrder[0]
        )
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('still returns the v19 attach snapshot for a desktop renderer replay', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: false,
        pid: 123,
        shellState: 'unsupported',
        snapshot: {
          scrollbackAnsi: 'legacy history\r\n',
          rehydrateSequences: '\x1b[?2004h',
          snapshotAnsi: 'legacy prompt',
          modes: { alternateScreen: false },
          cols: 80,
          rows: 24
        }
      } as never)
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 19 })
      try {
        const result = await legacy.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

        expect(result).toMatchObject({
          id: 'legacy-session',
          isReattach: true,
          snapshot: expect.stringContaining('legacy history')
        })
        expect(result.snapshot).toContain('legacy prompt')
        expect(result.providerSequence).toBeUndefined()
        await expect(legacy.getBufferSnapshot('legacy-session')).resolves.toBeNull()
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })
  })

  describe('getAppliedSize', () => {
    it('reports the spawn dims before any resize', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      expect(await adapter.getAppliedSize(id)).toEqual({ cols: 80, rows: 24 })
    })

    it('reflects the size the daemon actually applied after a resize', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.resize(id, 120, 40)
      await waitFor(() => vi.mocked(lastSubprocess.resize).mock.calls.length > 0)
      expect(await adapter.getAppliedSize(id)).toEqual({ cols: 120, rows: 40 })
    })

    // Why: a resize after exit is a dropped fire-and-forget notify; getAppliedSize must report the PTY's last real size, not the drop.
    it('does not advance when a resize is dropped after the session exited', async () => {
      const { id } = await adapter.spawn({ cols: 200, rows: 50 })

      // Child exits, then a late narrow resize races in; daemon Session.resize early-returns for an exited session so 80×24 never lands.
      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      adapter.resize(id, 80, 24)
      await new Promise((r) => setTimeout(r, 50))

      // The drop must stay visible: never resized to 80 cols, and getAppliedSize never reports 80 (stays wide, or null once reaped).
      expect(lastSubprocess.resize).not.toHaveBeenCalledWith(80, 24)
      const applied = await adapter.getAppliedSize(id)
      expect(applied?.cols).not.toBe(80)
    })
  })

  describe('getBufferSnapshot', () => {
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
  })

  describe('shutdown', () => {
    it('kills the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.shutdown(id, { immediate: false })
      expect(lastSubprocess.kill).toHaveBeenCalled()
    })

    it('force-kills immediately when requested', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.shutdown(id, { immediate: true })
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
    })

    // Why: shutdown can be the first lazy-client op after restart; connect before killing or a healthy session is orphaned (#7742).
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

  describe('sessionsNeedingFullCheckpoint cleanup (leak regression)', () => {
    // Why: cold-restore flags a session for a full checkpoint; exiting before it lands leaked a permanent Set entry for the daemon's life.
    it('clears the pending full-checkpoint flag when a session exits', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const internals = adapter as unknown as { sessionsNeedingFullCheckpoint: Set<string> }
      // Simulate the cold-restore reanchor path having flagged this session.
      internals.sessionsNeedingFullCheckpoint.add(id)
      expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(true)

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(false)
    })
  })

  describe('sendSignal', () => {
    it('sends signal to the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.sendSignal(id, 'SIGINT')

      expect(lastSubprocess.signal).toHaveBeenCalledWith('SIGINT')
    })
  })

  describe('getCwd', () => {
    it('returns empty string when no CWD tracked', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('getInitialCwd', () => {
    it('returns the cwd passed at spawn time', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24, cwd: '/home/user' })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('/home/user')
    })

    it('returns empty string when no cwd provided', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('clearBuffer', () => {
    it('does not throw', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await expect(adapter.clearBuffer(id)).resolves.toBeUndefined()
    })
  })

  describe('onData', () => {
    it('routes data events from daemon', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('hello')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'hello' })
    })

    it('coalesces burst data events before serializing daemon stream output', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('a')
      lastSubprocess._simulateData('b')
      lastSubprocess._simulateData('c')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads).toEqual([{ id, data: 'abc' }])
    })
  })

  describe('onExit', () => {
    it('routes exit events from daemon', async () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateExit(42)

      await waitFor(() => exits.length > 0)
      expect(exits[0]).toEqual({ id, code: 42 })
    })
  })

  describe('spawn with sessionId (reattach)', () => {
    it('returns full snapshot and isReattach when reattaching', async () => {
      const sessionId = 'reattach-test-session'
      const first = await adapter.spawn({ cols: 80, rows: 24, sessionId, launchAgent: 'droid' })
      expect(first.id).toBe(sessionId)
      expect(first.isReattach).toBeUndefined()
      expect(first.launchAgent).toBe('droid')

      // Write data so the headless emulator captures it
      lastSubprocess._simulateData('hello from shell\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Spawn again with the same sessionId — should reattach
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

    it('includes rehydrateSequences in snapshot when terminal modes are active', async () => {
      const sessionId = 'rehydrate-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      // Enable bracketed paste mode, then write visible output
      lastSubprocess._simulateData('\x1b[?2004h')
      lastSubprocess._simulateData('prompt$ ')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(result.snapshot).toContain('\x1b[?2004h')
      expect(result.snapshot).toContain('prompt$')
    })

    it('returns plain result for new sessionId', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'brand-new' })
      expect(result.id).toBe('brand-new')
      expect(result.isReattach).toBeUndefined()
      expect(result.snapshot).toBeUndefined()
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
    })
  })

  describe('attach', () => {
    it('reattaches to existing session and receives events', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      // Create a second adapter simulating app restart
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const dataPayloads: { id: string; data: string }[] = []
      adapter2.onData((payload) => dataPayloads.push(payload))

      await adapter2.attach(id)

      lastSubprocess._simulateData('after-reattach')
      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'after-reattach' })

      adapter2.dispose()
    })
  })

  describe('listProcesses', () => {
    it('returns active sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24, cwd: '/repo/owned-before-osc7' })
      await adapter.spawn({ cols: 80, rows: 24 })

      const procs = await adapter.listProcesses()
      expect(procs).toHaveLength(2)
      expect(procs[0]).toHaveProperty('id')
      expect(procs[0]).toHaveProperty('cwd')
      expect(procs[0]).toHaveProperty('title')
      expect(procs[0].cwd).toBe('/repo/owned-before-osc7')
    })
  })

  describe('hasChildProcesses / getForegroundProcess', () => {
    it('returns false for shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('bash')
      expect(await adapter.hasChildProcesses(id)).toBe(false)
    })

    it('returns true for non-shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.hasChildProcesses(id)).toBe(true)
    })

    it('returns the foreground process', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.getForegroundProcess(id)).toBe('codex')
    })
  })

  describe('serialize / revive', () => {
    it('serialize returns JSON', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const state = await adapter.serialize([id])
      expect(() => JSON.parse(state)).not.toThrow()
    })

    it('revive does not throw', async () => {
      await expect(adapter.revive('{}')).resolves.toBeUndefined()
    })
  })

  describe('getDefaultShell / getProfiles', () => {
    it('returns a shell path', async () => {
      const shell = await adapter.getDefaultShell()
      expect(shell.length).toBeGreaterThan(0)
    })

    it('returns profiles', async () => {
      const profiles = await adapter.getProfiles()
      expect(Array.isArray(profiles)).toBe(true)
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

    it('allows spawn for different sessionId after shutdown', async () => {
      await adapter.spawn({ cols: 80, rows: 24, sessionId: 'kill-me' })
      await adapter.shutdown('kill-me', { immediate: true })

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'fresh-one' })
      expect(result.id).toBe('fresh-one')
    })

    it('clearTombstone allows re-spawn', async () => {
      const sessionId = 'cleared-tombstone'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      adapter.clearTombstone(sessionId)

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
    })

    it('evicts oldest tombstone when exceeding limit', async () => {
      // Why: MAX_TOMBSTONES is 1000; spawning that many is slow, so verify eviction with a small batch via the public spawn API.
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const id = `evict-${i}`
        ids.push(id)
        await adapter.spawn({ cols: 80, rows: 24, sessionId: id })
        await adapter.shutdown(id, { immediate: true })
      }

      // All 5 should be tombstoned
      for (const id of ids) {
        await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: id })).rejects.toThrow(
          'was explicitly killed'
        )
      }

      // clearTombstone the first one, then re-kill it — it should still work
      adapter.clearTombstone(ids[0])
      await adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })
      await adapter.shutdown(ids[0], { immediate: true })

      // First tombstone was re-added at the Map's end, so eviction order is now [evict-1, evict-2, evict-3, evict-4, evict-0]
      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })).rejects.toThrow(
        'was explicitly killed'
      )
    })
  })

  describe('reconcileOnStartup', () => {
    it('returns alive sessions for valid worktrees', async () => {
      const wt = 'repo-a::/wt/active'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([wt]))
      expect(alive).toHaveLength(1)
      expect(alive[0]).toContain(wt)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions for removed worktrees', async () => {
      const wt = 'repo-a::/wt/removed'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set(['repo-a::/wt/other']))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
      expect(killed[0]).toContain(wt)
    })

    it('handles mix of valid and orphaned sessions', async () => {
      const keep = 'repo-a::/wt/keep'
      const drop = 'repo-a::/wt/delete'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: keep })
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: drop })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([keep]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(1)
    })

    it('correctly parses hyphenated worktreeIds', async () => {
      const complexId = 'repo-abc::/Users/dev/my-feature-branch'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: complexId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([complexId]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions whose id does not match the minted format, even if id is in valid set', async () => {
      // Why: parsePtySessionId rejects ids with no worktree shape, so they're orphaned regardless of valid-set membership.
      const sessionId = 'bare-uuid-no-separators'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([sessionId]))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
    })
  })

  describe('dispose', () => {
    it('disconnects without killing sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      adapter.dispose()

      // Session survives — verify by connecting new adapter
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const procs = await adapter2.listProcesses()
      expect(procs).toHaveLength(1)
      adapter2.dispose()
    })
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

    it('does not write to disk on individual data events (checkpoint-based)', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        sessionId: 'hist-test'
      })

      lastSubprocess._simulateData('hello from pty\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence writes checkpoint.json on a timer, never scrollback.bin per data event.
      expect(existsSync(join(historyDir, getHistorySessionDirName(id), 'scrollback.bin'))).toBe(
        false
      )
    })

    it('appends increments for only dirty sessions on the periodic timer', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 25

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'dirty-checkpoint'
        })
        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')
        const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')

        await new Promise((r) => setTimeout(r, 80))

        // Why: idle terminals can be numerous; a periodic pass with no data must not serialize every live session.
        expect(appendSpy).not.toHaveBeenCalled()

        lastSubprocess._simulateData('new output\r\n')
        await waitFor(() => appendSpy.mock.calls.length === 1)
        expect(appendSpy).toHaveBeenCalledWith(id, expect.any(Number), [
          { kind: 'output', data: 'new output\r\n' }
        ])
        // Why: the periodic tick must persist increments, never re-serialize the full emulator buffer (the issue #5096 stall).
        expect(checkpointSpy).not.toHaveBeenCalled()
        const logPath = join(historyDir, getHistorySessionDirName(id), 'output.log')
        await waitFor(() => {
          try {
            return readFileSync(logPath).includes('new output')
          } catch {
            return false
          }
        })

        await new Promise((r) => setTimeout(r, 80))
        expect(appendSpy).toHaveBeenCalledTimes(1)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('limits concurrent checkpoint snapshot and disk work', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const releaseSnapshotRequests: (() => void)[] = []
      const requestedSessionIds: string[] = []
      let inFlight = 0
      let maxInFlight = 0
      const request = vi.fn(async (_type: string, payload: { sessionId: string }) => {
        requestedSessionIds.push(payload.sessionId)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => {
          releaseSnapshotRequests.push(() => {
            inFlight--
            resolve()
          })
        })
        return {
          records: [{ kind: 'output', data: payload.sessionId }],
          seq: 1,
          overflowed: false,
          snapshot: null
        }
      })
      const checkpoint = vi.fn(async () => {})
      const appendIncrements = vi.fn(async () => 'ok' as const)
      const dispose = vi.fn(async () => {})
      const disconnect = vi.fn()
      const internals = historyAdapter as unknown as {
        client: { request: typeof request; disconnect: typeof disconnect }
        historyManager: {
          checkpoint: typeof checkpoint
          appendIncrements: typeof appendIncrements
          dispose: typeof dispose
        }
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      internals.client = { request, disconnect }
      internals.historyManager = { checkpoint, appendIncrements, dispose }

      const checkpointing = internals.checkpointSessions(['a', 'b', 'c', 'd', 'e', 'f'])
      await waitFor(() => requestedSessionIds.length === 4)

      expect(maxInFlight).toBe(4)
      expect(requestedSessionIds).toEqual(['a', 'b', 'c', 'd'])

      for (const release of releaseSnapshotRequests.splice(0)) {
        release()
      }
      await waitFor(() => requestedSessionIds.length === 6)

      expect(maxInFlight).toBe(4)

      for (const release of releaseSnapshotRequests.splice(0)) {
        release()
      }
      await expect(checkpointing).resolves.toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']))
      expect(appendIncrements).toHaveBeenCalledTimes(6)
      expect(checkpoint).not.toHaveBeenCalled()
    })

    describe('full-snapshot cooldown', () => {
      type CooldownInternals = {
        client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
        historyManager: {
          checkpoint: ReturnType<typeof vi.fn>
          appendIncrements: ReturnType<typeof vi.fn>
          dispose: ReturnType<typeof vi.fn>
        }
        checkpointSessions(
          sessionIds: Iterable<string>,
          opts?: { final?: boolean; teardown?: boolean }
        ): Promise<Set<string>>
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }

      function makeCooldownHarness(takeResult: {
        overflowed: boolean
        appendResult?: 'ok' | 'needs-checkpoint'
      }): CooldownInternals {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
          if (payload.includeSnapshot === true) {
            return { records: [], seq: 2, overflowed: false, snapshot: { cols: 80, rows: 24 } }
          }
          return {
            records: [{ kind: 'output', data: 'x' }],
            seq: 1,
            overflowed: takeResult.overflowed,
            snapshot: null
          }
        })
        const internals = historyAdapter as unknown as CooldownInternals
        internals.client = { request, disconnect: vi.fn() }
        internals.historyManager = {
          checkpoint: vi.fn(async () => {}),
          appendIncrements: vi.fn(async () => takeResult.appendResult ?? 'ok'),
          dispose: vi.fn(async () => {})
        }
        return internals
      }

      it('bounds overflow-triggered full snapshots to one per cooldown window', async () => {
        const internals = makeCooldownHarness({ overflowed: true })

        // First overflow: full snapshot allowed immediately.
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set(['hot']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)

        // Second tick inside the cooldown: the overflow defers and flags the session; no snapshot write.
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set())
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.sessionsNeedingFullCheckpoint.has('hot')).toBe(true)
        const requestsAfterSecondTick = internals.client.request.mock.calls.length

        // Ticks 3..24 (a hot session over ~2 minutes): flagged + cooling down short-circuits with zero daemon RPCs and zero disk writes.
        for (let i = 0; i < 22; i++) {
          await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set())
        }
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.client.request.mock.calls.length).toBe(requestsAfterSecondTick)

        // Cooldown expiry: the deferred full snapshot lands and clears the flag.
        internals.lastFullCheckpointAt.set('hot', Date.now() - 46_000)
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set(['hot']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(2)
        expect(internals.sessionsNeedingFullCheckpoint.has('hot')).toBe(false)
      })

      it('lets final checkpoints bypass the cooldown', async () => {
        const internals = makeCooldownHarness({ overflowed: true })
        await internals.checkpointSessions(['hot'])
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)

        // Cooldown is active, but quit/sleep persistence must not defer — stale-on-crash is acceptable, stale-on-clean-exit is not.
        await expect(internals.checkpointSessions(['hot'], { final: true })).resolves.toEqual(
          new Set(['hot'])
        )
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(2)
      })

      it('defers log-cap (needs-checkpoint) snapshots inside the cooldown', async () => {
        const internals = makeCooldownHarness({
          overflowed: false,
          appendResult: 'needs-checkpoint'
        })
        internals.lastFullCheckpointAt.set('capped', Date.now())

        await expect(internals.checkpointSessions(['capped'])).resolves.toEqual(new Set())
        expect(internals.historyManager.checkpoint).not.toHaveBeenCalled()
        expect(internals.sessionsNeedingFullCheckpoint.has('capped')).toBe(true)

        internals.lastFullCheckpointAt.set('capped', Date.now() - 46_000)
        await expect(internals.checkpointSessions(['capped'])).resolves.toEqual(new Set(['capped']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.sessionsNeedingFullCheckpoint.has('capped')).toBe(false)
      })
    })

    it('does not schedule a checkpoint timer until a session is dirty', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'idle-checkpoint'
        })

        expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10_000)).toBe(false)

        lastSubprocess._simulateData('dirty after idle\r\n')
        await waitFor(() => setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10_000))
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
        setTimeoutSpy.mockRestore()
      }
    })

    it('clears a pending checkpoint timer when the last dirty session closes', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'close-dirty-checkpoint'
        })
        const internals = historyAdapter as unknown as {
          dirtySessionVersions: Map<string, number>
        }

        lastSubprocess._simulateData('dirty before close\r\n')
        await waitFor(() => internals.dirtySessionVersions.has(id))
        const callsBeforeClose = clearTimeoutSpy.mock.calls.length

        await historyAdapter.shutdown(id, { immediate: true })

        expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeClose)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
        clearTimeoutSpy.mockRestore()
      }
    })

    it('checkpoints before keep-history shutdown so sleep can cold restore latest output', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'sleep-checkpoint'
        })
        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

        lastSubprocess._simulateData('latest before sleep\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

        expect(checkpointSpy).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ snapshotAnsi: expect.stringContaining('latest before sleep') })
        )
        expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)

        const restored = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(restored.coldRestore?.scrollback).toContain('latest before sleep')
        historyAdapter.ackColdRestore(id)

        const remountAfterAck = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(remountAfterAck.coldRestore).toBeUndefined()
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('cold restores the second sleep/wake cycle with post-wake output', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'sleep-wake-cycles'
        })

        lastSubprocess._simulateData('first cycle content\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })
        const metaPath = join(historyDir, getHistorySessionDirName(id), 'meta.json')
        const checkpointPath = join(historyDir, getHistorySessionDirName(id), 'checkpoint.json')
        // Why: keep-history sleep stays unclean so cold restore stays eligible; the final checkpoint is the deterministic handoff signal.
        expect(JSON.parse(readFileSync(metaPath, 'utf-8')).endedAt).toBeNull()
        expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).snapshotAnsi).toContain(
          'first cycle content'
        )

        const firstWake = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(firstWake.coldRestore?.scrollback).toContain('first cycle content')
        historyAdapter.ackColdRestore(id)
        expect(historyAdapter.hasPty(id)).toBe(true)

        lastSubprocess._simulateData('second cycle content\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })
        expect(JSON.parse(readFileSync(metaPath, 'utf-8')).endedAt).toBeNull()
        expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).snapshotAnsi).toContain(
          'second cycle content'
        )

        const secondWake = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(secondWake.coldRestore?.scrollback).toContain('second cycle content')
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('writes meta.json with endedAt on exit', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'exit-hist'
      })

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(id), 'meta.json'), 'utf-8')
      )
      expect(meta.endedAt).toBeDefined()
      expect(meta.exitCode).toBe(0)
    })

    it('removes history on explicit shutdown', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'shutdown-hist'
      })

      lastSubprocess._simulateData('data')
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)

      await historyAdapter.shutdown(id, { immediate: true })
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(false)
    })

    it('writes a final checkpoint before keepHistory shutdown', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        sessionId: 'sleep-checkpoint'
      })
      const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

      lastSubprocess._simulateData('fresh output before sleep\r\n')
      await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

      expect(checkpointSpy).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ snapshotAnsi: expect.stringContaining('fresh output') })
      )
      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)
    })

    itOnPosix('persists final take records that are not represented in the snapshot', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        command: 'printf ready',
        env: { SHELL: '/bin/zsh' },
        sessionId: 'sleep-checkpoint-tail'
      })
      const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')

      lastSubprocess._simulateData('\x1b]777;orca-shell-ready')
      await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

      expect(appendSpy).toHaveBeenCalledWith(id, expect.any(Number), [
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
    })

    it('returns cold restore data when disk history has unclean shutdown', async () => {
      // Simulate a previous daemon crash: write history files without endedAt
      const sessionId = 'cold-restore-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 120,
          rows: 40,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), '$ npm run dev\r\nServer running...\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('Server running')
      expect(result.coldRestore!.cwd).toBe('/projects/myapp')
      expect(result.coldRestore).toMatchObject({ cols: 120, rows: 40 })
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: '/projects/myapp',
        cols: 120,
        rows: 40
      })
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

    it('re-anchors a cold-restored session with a full checkpoint on the first tick', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 25

      try {
        // Simulate a previous daemon crash with stale checkpoint + log files.
        const sessionId = 'cold-restore-reanchor'
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
        writeFileSync(join(sessionDir, 'scrollback.bin'), 'pre-crash output\r\n')

        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
        expect(result.coldRestore).toBeDefined()

        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')
        const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')

        lastSubprocess._simulateData('revived session output\r\n')
        await waitFor(() => checkpointSpy.mock.calls.length === 1)

        // Why: appending fresh records to the pre-crash log would fail the sequence check on a second crash; a full checkpoint resets the log to a new generation.
        expect(appendSpy).not.toHaveBeenCalled()
        expect(checkpointSpy).toHaveBeenCalledWith(
          sessionId,
          expect.objectContaining({ snapshotAnsi: expect.stringContaining('revived session') })
        )

        // Subsequent ticks return to incremental appends.
        lastSubprocess._simulateData('later output\r\n')
        await waitFor(() => appendSpy.mock.calls.length === 1)
        expect(checkpointSpy).toHaveBeenCalledTimes(1)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('clears a stale snapshot cooldown when the cold-restore re-anchor is flagged', async () => {
      // Simulate a previous daemon crash with recoverable history on disk.
      const sessionId = 'cold-restore-stale-cooldown'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'pre-crash output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        lastFullCheckpointAt: Map<string, number>
        sessionsNeedingFullCheckpoint: Set<string>
      }
      // A daemon respawn inside one adapter keeps this map, so seed a fresh cooldown as if the pre-crash generation just snapshotted.
      internals.lastFullCheckpointAt.set(sessionId, Date.now())

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      // The revived generation has no checkpoint of its own — the re-anchor must not inherit the previous generation's cooldown.
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('re-anchors a warm reattach the adapter was not already managing', async () => {
      const sessionId = 'warm-reattach-reanchor'
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await first.spawn({ cols: 80, rows: 24, sessionId })
      first.dispose()

      // The old adapter may have drained records it never persisted (deferred hot-session tick), so appends must wait for a full snapshot to re-anchor the log.
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('skips the cold-restore replay when the daemon session is still alive', async () => {
      const sessionId = 'warm-reattach-skip-replay'
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await first.spawn({ cols: 80, rows: 24, cwd: '/home/user', sessionId })
      // Why disconnectOnly: the app-quit path leaves meta.endedAt null, keeping the session crash-recoverable like every relaunch with a live daemon.
      await first.disconnectOnly()

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const reader = (historyAdapter as unknown as { historyReader: HistoryReader }).historyReader
      const detectSpy = vi.spyOn(reader, 'detectColdRestore')
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.isReattach).toBe(true)
      expect(result.coldRestore).toBeUndefined()
      expect(detectSpy).not.toHaveBeenCalled()
      // The unmanaged-reattach re-anchor must survive the skipped detect.
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('does not probe session aliveness when there is no restorable history', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const requestSpy = vi.spyOn(client, 'request')

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId: 'fresh-no-history' })

      expect(requestSpy.mock.calls.map((call) => call[0])).not.toContain('getSize')
    })

    it('recovers cold restore when the probed session dies before createOrAttach', async () => {
      const sessionId = 'probe-race-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/raced',
          cols: 100,
          rows: 30,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'raced output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      // Why: simulates the probe→createOrAttach race (session dies mid-call, writing endedAt); fallback detect must still restore, not fall through to openSession which deletes the checkpoint.
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        if (type === 'getSize') {
          return { size: { cols: 100, rows: 30 } }
        }
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          writeFileSync(
            join(sessionDir, 'meta.json'),
            JSON.stringify({
              cwd: '/projects/raced',
              cols: 100,
              rows: 30,
              startedAt: '2026-04-15T10:00:00Z',
              endedAt: '2026-04-15T10:05:00Z',
              exitCode: 0
            })
          )
        }
        return response
      })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('raced output')
      // The unseeded race winner is replaced before exposure, so the retained shell uses recovered dimensions as well as history.
      expect(lastSpawnOpts).toMatchObject({ sessionId, cols: 100, rows: 30 })
      // The recovery data must survive — openSession would have deleted it.
      expect(existsSync(join(sessionDir, 'scrollback.bin'))).toBe(true)
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('falls back to the full cold-restore detect when the aliveness probe fails', async () => {
      const sessionId = 'probe-error-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/probeless',
          cols: 132,
          rows: 43,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'probeless output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      // Why: an old daemon rejects the unknown getSize method; the spawn must behave exactly like the unprobed path.
      vi.spyOn(client, 'request').mockImplementation((type: string, payload?: unknown) => {
        if (type === 'getSize') {
          return Promise.reject(new Error('Unknown request type'))
        }
        return originalRequest(type, payload)
      })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('probeless output')
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: '/projects/probeless',
        cols: 132,
        rows: 43
      })
    })

    it('returns same cold restore on StrictMode double-mount (sticky cache)', async () => {
      const sessionId = 'sticky-cache-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const first = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(first.coldRestore).toBeDefined()

      // Second call (StrictMode remount) should get cached data
      const second = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.coldRestore).toBeDefined()
      expect(second.coldRestore!.scrollback).toBe('cached output')

      // After ack, cold restore should not be returned
      historyAdapter.ackColdRestore(sessionId)
      const third = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(third.coldRestore).toBeUndefined()
    })

    it('drops sticky cold restore data on explicit shutdown', async () => {
      const sessionId = 'sticky-cache-shutdown-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        coldRestoreCache: Map<string, { scrollback: string; cwd: string; oscLinks?: unknown[] }>
      }

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(internals.coldRestoreCache.has(sessionId)).toBe(true)

      await historyAdapter.shutdown(sessionId, { immediate: true })

      expect(internals.coldRestoreCache.has(sessionId)).toBe(false)
    })

    it('drops sticky cold restore data on natural exit', async () => {
      const sessionId = 'sticky-cache-exit-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        coldRestoreCache: Map<string, { scrollback: string; cwd: string; oscLinks?: unknown[] }>
      }

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(internals.coldRestoreCache.has(sessionId)).toBe(true)

      lastSubprocess._simulateExit(0)
      await waitFor(() => !internals.coldRestoreCache.has(sessionId))
    })

    it('opens session for checkpointing after cold restore', async () => {
      const sessionId = 'post-restore-data'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeDefined()

      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence doesn't seed scrollback.bin — new data lands via the periodic checkpoint timer, not per-chunk appendData.
      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'), 'utf-8')
      )
      expect(meta.cwd).toBe('/tmp')
      expect(meta.cols).toBe(80)
      expect(meta.rows).toBe(24)
    })

    it('keeps recovered scrollback when the fresh daemon session re-anchors history', async () => {
      const sessionId = 'cold-restore-reanchor'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-10T08:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'recovered marker\r\n')
      subprocessDataOnSubscribe = 'fresh shell output\r\n'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore?.scrollback).toContain('recovered marker')

      const internals = historyAdapter as unknown as {
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      await internals.checkpointSessions([sessionId])
      const checkpointPath = join(sessionDir, 'checkpoint.json')
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))

      expect(checkpoint.snapshotAnsi).toContain('recovered marker')
      expect(checkpoint.snapshotAnsi).toContain('fresh shell output')
      expect(checkpoint.snapshotAnsi.indexOf('recovered marker')).toBeLessThan(
        checkpoint.snapshotAnsi.indexOf('fresh shell output')
      )
    })

    it('keeps recovery persistence suspended across an adapter restart after seed failure', async () => {
      const sessionId = 'cold-restore-seed-failure'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-10T08:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'recovered marker\r\n')

      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const originalWriteSync = HeadlessEmulator.prototype.writeSync
      const writeSyncSpy = vi
        .spyOn(HeadlessEmulator.prototype, 'writeSync')
        .mockImplementation(function (this: HeadlessEmulator, data) {
          return data.includes('recovered marker') ? false : originalWriteSync.call(this, data)
        })
      try {
        await first.spawn({ cols: 80, rows: 24, sessionId })
        lastSubprocess._simulateData('fresh-only output\r\n')
        await first.disconnectOnly()

        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
        expect(result.coldRestore?.scrollback).toContain('recovered marker')
        const internals = historyAdapter as unknown as {
          checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
        }
        await internals.checkpointSessions([sessionId])

        expect(existsSync(join(sessionDir, 'checkpoint.json'))).toBe(false)
        expect(readFileSync(join(sessionDir, 'scrollback.bin'), 'utf8')).toContain(
          'recovered marker'
        )
      } finally {
        writeSyncSpy.mockRestore()
      }
    })

    it('does not cold-restore for clean shutdown (endedAt set)', async () => {
      const sessionId = 'clean-exit'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: '2026-04-15T12:00:00Z',
          exitCode: 0
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old data')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeUndefined()
    })

    it('stores history under an encoded directory key for Windows-safe session ids', async () => {
      const sessionId = 'repo1::/path/wt1@@abcd'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        sessionId
      })

      expect(id).toBe(sessionId)
      expect(existsSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'))).toBe(
        true
      )
    })
  })

  describe('respawn on daemon death', () => {
    it('respawns the daemon and retries when the socket disappears', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn succeeds normally
      const r1 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r1.id).toBeDefined()

      // Kill the server to simulate daemon death
      await server.shutdown()

      // Next spawn should detect the dead socket, call respawn, and succeed
      const r2 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledOnce()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('propagates the error when no respawn callback is provided', async () => {
      const noRespawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })

      // First spawn succeeds
      await noRespawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill the server
      await server.shutdown()

      // Next spawn should fail with the original socket error
      await expect(noRespawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow()

      noRespawnAdapter.dispose()
    })

    it('treats a hello handshake timeout as daemon-gone and respawns (#8689)', async () => {
      // Why: a wedged daemon accepts the socket but never answers hello; classify as daemon-gone so withDaemonRetry respawns, else every spawn fails forever.
      const realEnsureConnected = DaemonClient.prototype.ensureConnected
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockImplementationOnce(async () => {
          // The exact error type + message the real client raises on a wedge.
          throw new DaemonProtocolError('Hello response timed out')
        })
        .mockImplementation(function (this: DaemonClient) {
          return realEnsureConnected.call(this)
        })
      const respawnFn = vi.fn(async () => {})
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      try {
        const result = await respawnAdapter.spawn({ cols: 80, rows: 24 })
        expect(result.id).toBeDefined()
        expect(respawnFn).toHaveBeenCalledOnce()
      } finally {
        ensureConnectedSpy.mockRestore()
        respawnAdapter.dispose()
      }
    })

    it('coalesces concurrent respawns so only one daemon is forked', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn connects
      await respawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill daemon
      await server.shutdown()

      // Fire two spawns concurrently — both should succeed but only one respawn
      const [r1, r2] = await Promise.all([
        respawnAdapter.spawn({ cols: 80, rows: 24 }),
        respawnAdapter.spawn({ cols: 80, rows: 24 })
      ])
      expect(r1.id).toBeDefined()
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledOnce()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('preserves an unhealthy macOS resolver daemon when it owns live sessions', async () => {
      const respawnFn = vi.fn()
      const exits: { id: string; code: number }[] = []
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      respawnAdapter.onExit((payload) => exits.push(payload))
      const existing = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(exits).toEqual([])
      expect(next.id).toBeDefined()
      expect(next.id).not.toBe(existing.id)

      respawnAdapter.dispose()
    })

    it('preserves an unhealthy macOS resolver daemon when live sessions have not been reconciled locally', async () => {
      const respawnFn = vi.fn()
      const background = await adapter.spawn({ cols: 80, rows: 24 })
      const backgroundSubprocess = lastSubprocess
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()
      expect(next.id).not.toBe(background.id)
      expect(backgroundSubprocess.forceKill).not.toHaveBeenCalled()

      respawnAdapter.dispose()
    })

    it('replaces an unhealthy macOS resolver daemon before creating a fresh session when no sessions are active', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        await server.shutdown()
        rmSync(socketPath, { force: true })
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })
      const exits: { id: string; code: number }[] = []
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      respawnAdapter.onExit((payload) => exits.push(payload))
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const replacement = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).toHaveBeenCalledOnce()
      expect(exits).toEqual([])
      expect(replacement.id).toBeDefined()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('does not resolver-health restart attach-style spawns', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const result = await respawnAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'caller-owned-session'
      })

      expect(result.id).toBe('caller-owned-session')
      expect(getMacDaemonSystemResolverHealthMock).not.toHaveBeenCalled()
      expect(respawnFn).not.toHaveBeenCalled()

      respawnAdapter.dispose()
    })

    it('propagates respawn failure to the caller', async () => {
      const respawnFn = vi.fn(async () => {
        throw new Error('Daemon entry file missing')
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      await respawnAdapter.spawn({ cols: 80, rows: 24 })
      await server.shutdown()

      await expect(respawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
        'Daemon entry file missing'
      )

      respawnAdapter.dispose()
    })
  })

  // Why: daemon kill-all-and-shutdown doesn't fan exits through onExit, so these primitives synthesize pty:exit before dispose, else the renderer black-holes writes (docs/daemon-staleness-ux.md §Phase 1).
  describe('fanoutSyntheticExits / getActiveSessionIds (restart primitives)', () => {
    it('reports every live spawn in getActiveSessionIds', async () => {
      const { id: id1 } = await adapter.spawn({ cols: 80, rows: 24 })
      const { id: id2 } = await adapter.spawn({ cols: 80, rows: 24 })
      const active = adapter.getActiveSessionIds()
      expect(active).toContain(id1)
      expect(active).toContain(id2)
      expect(active).toHaveLength(2)
    })

    it('emits a synthetic exit for every active id with the supplied code', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const ids = ['sess-a', 'sess-b', 'sess-c']
      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      for (const id of ids) {
        internals.activeSessionIds.add(id)
      }

      adapter.fanoutSyntheticExits(-1)

      expect(exits).toHaveLength(3)
      expect(exits.map((e) => e.id).sort()).toEqual([...ids].sort())
      for (const { code } of exits) {
        expect(code).toBe(-1)
      }
    })

    it('clears activeSessionIds after fanout so a second call is a no-op', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
      expect(adapter.getActiveSessionIds()).toEqual([])

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
    })

    it('propagates to every registered exit listener in order', () => {
      const aExits: { id: string; code: number }[] = []
      const bExits: { id: string; code: number }[] = []
      adapter.onExit((payload) => aExits.push(payload))
      adapter.onExit((payload) => bExits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)

      expect(aExits).toEqual([{ id: 'sess-a', code: -1 }])
      expect(bExits).toEqual([{ id: 'sess-a', code: -1 }])
    })
  })
})
