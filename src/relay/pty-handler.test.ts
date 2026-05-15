/* oxlint-disable max-lines */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { mockPtySpawn, mockPtyInstance } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockPtyInstance: {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

import { PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: { isStale: () => boolean }) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  const dispatcher = {
    onRequest: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context?: { isStale: () => boolean }
        ) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    // Helpers for tests
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _notifications: notifications,
    async callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: { isStale: () => boolean }
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, context)
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params)
    }
  }

  return dispatcher
}

describe('PtyHandler', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: PtyHandler

  beforeEach(() => {
    vi.useFakeTimers()
    mockPtySpawn.mockReset()
    mockPtyInstance.onData.mockReset()
    mockPtyInstance.onExit.mockReset()
    mockPtyInstance.write.mockReset()
    mockPtyInstance.resize.mockReset()
    mockPtyInstance.kill.mockReset()
    mockPtyInstance.clear.mockReset()

    mockPtySpawn.mockReturnValue({ ...mockPtyInstance })

    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
  })

  afterEach(() => {
    handler.dispose()
    vi.useRealTimers()
  })

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('pty.spawn')
    expect(methods).toContain('pty.attach')
    expect(methods).toContain('pty.shutdown')
    expect(methods).toContain('pty.sendSignal')
    expect(methods).toContain('pty.getCwd')
    expect(methods).toContain('pty.getInitialCwd')
    expect(methods).toContain('pty.clearBuffer')
    expect(methods).toContain('pty.hasChildProcesses')
    expect(methods).toContain('pty.getForegroundProcess')
    expect(methods).toContain('pty.listProcesses')
    expect(methods).toContain('pty.getDefaultShell')

    const notifMethods = Array.from(dispatcher._notificationHandlers.keys())
    expect(notifMethods).toContain('pty.data')
    expect(notifMethods).toContain('pty.resize')
    expect(notifMethods).toContain('pty.ackData')
  })

  it('spawns a PTY and returns an id', async () => {
    const result = await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
    expect(result).toEqual({ id: 'pty-1' })
    expect(mockPtySpawn).toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('terminates spawned PTY when request becomes stale before response', async () => {
    const killSpy = vi.fn()
    const term = { ...mockPtyInstance, kill: killSpy, onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest('pty.spawn', {}, { isStale: () => true })

    // Why: assert via the captured spy reference rather than term.kill because
    // disposeManagedPty() neutralizes managed.pty.kill (replaces it with a
    // no-op) on POSIX to close the UnixTerminal.destroy() → socket-close →
    // SIGHUP-to-recycled-pid race. After the 5s timer fires, term.kill is the
    // neutralized function, not the original spy. killSpy retains call history.
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    vi.advanceTimersByTime(5000)
    expect(killSpy).toHaveBeenCalledWith('SIGKILL')
  })

  it('increments PTY ids on each spawn', async () => {
    const r1 = await dispatcher.callRequest('pty.spawn', {})
    const r2 = await dispatcher.callRequest('pty.spawn', {})
    expect((r1 as { id: string }).id).toBe('pty-1')
    expect((r2 as { id: string }).id).toBe('pty-2')
  })

  it('accepts SIGWINCH for restored TUI repaint', async () => {
    await dispatcher.callRequest('pty.spawn', {})

    await dispatcher.callRequest('pty.sendSignal', { id: 'pty-1', signal: 'SIGWINCH' })

    const term = mockPtySpawn.mock.results[0].value
    expect(term.kill).toHaveBeenCalledWith('SIGWINCH')
  })

  it('forwards data from PTY to dispatcher notifications', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    expect(dataCallback).toBeDefined()

    dataCallback!('hello world')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello world' })
  })

  it('returns attach replay instead of notifying when replay notification is suppressed', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('buffered output')

    const result = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })

    expect(result).toEqual({ replay: 'buffered output' })
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.replay', expect.anything())
  })

  it('notifies replay on normal attach', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('buffered output')
    dispatcher.notify.mockClear()

    const result = await dispatcher.callRequest('pty.attach', { id: 'pty-1' })

    expect(result).toEqual({})
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.replay', {
      id: 'pty-1',
      data: 'buffered output'
    })
  })

  it('notifies on PTY exit and removes from map', async () => {
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCallback = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    expect(handler.activePtyCount).toBe(1)

    exitCallback!({ exitCode: 0 })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: 0 })
    expect(handler.activePtyCount).toBe(0)
  })

  it('writes data to PTY via pty.data notification', async () => {
    const mockWrite = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      write: mockWrite,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'ls\n' })
    expect(mockWrite).toHaveBeenCalledWith('ls\n')
  })

  it('resizes PTY via pty.resize notification', async () => {
    const mockResize = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      resize: mockResize,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
    expect(mockResize).toHaveBeenCalledWith(120, 40)
  })

  it('kills PTY on shutdown with SIGTERM by default', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
  })

  it('notifies pty.exit when graceful shutdown falls back to SIGKILL', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-fallback:0' } })
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    vi.advanceTimersByTime(5000)
    onExitCb!({ exitCode: 137 })

    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: -1 })
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-fallback:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('kills PTY on shutdown with SIGKILL when immediate', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('throws for attach on nonexistent PTY', async () => {
    await expect(dispatcher.callRequest('pty.attach', { id: 'pty-999' })).rejects.toThrow(
      'PTY "pty-999" not found'
    )
  })

  it('grace timer waits full period even when no PTYs exist', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('grace timer fires after configured delay when PTYs exist', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('cancelGraceTimer prevents expiration', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(60_000)
    handler.cancelGraceTimer()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('attach preserves buffer so repeated attaches return the same data plus new output', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('initial output')

    const r1 = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(r1).toEqual({ replay: 'initial output' })

    dataCallback!(' more')

    const r2 = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(r2).toEqual({ replay: 'initial output more' })
  })

  it('second app restart still replays full buffer', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})

    dataCallback!('$ while true; do date; done\r\n')
    dataCallback!('Mon Apr 28\r\n')

    await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })

    dataCallback!('Tue Apr 29\r\n')

    await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })

    dataCallback!('Wed Apr 30\r\n')

    const result = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(result).toEqual({
      replay: '$ while true; do date; done\r\nMon Apr 28\r\nTue Apr 29\r\nWed Apr 30\r\n'
    })
  })

  it('applies env augmenters after process.env and renderer-supplied env (augmenter wins on key conflict)', async () => {
    handler.addEnvAugmenter(() => ({
      ORCA_AGENT_HOOK_PORT: '12345',
      ORCA_AGENT_HOOK_TOKEN: 'abc-uuid',
      // Why: also override a key the renderer supplied below so the test pins
      // the documented "augmenter wins on key conflict" invariant — see the
      // doc-comment on addEnvAugmenter in pty-handler.ts.
      ORCA_PANE_KEY: 'augmenter-wins'
    }))

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: 'tab-1:0', ORCA_TAB_ID: 'tab-1' }
    })

    expect(mockPtySpawn).toHaveBeenCalled()
    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.ORCA_AGENT_HOOK_PORT).toBe('12345')
    expect(callArgs.env.ORCA_AGENT_HOOK_TOKEN).toBe('abc-uuid')
    // Augmenter override beats the renderer-supplied value:
    expect(callArgs.env.ORCA_PANE_KEY).toBe('augmenter-wins')
    // Renderer-supplied keys not in augmenter map flow through:
    expect(callArgs.env.ORCA_TAB_ID).toBe('tab-1')
  })

  it('passes the PTY id and renderer paneKey to env augmenters', async () => {
    const seenContexts: { id: string; paneKey?: string; env: Record<string, string> }[] = []
    handler.addEnvAugmenter((ctx) => {
      seenContexts.push(ctx)
      return {
        OVERLAY_ID: ctx.paneKey ?? ctx.id
      }
    })

    await dispatcher.callRequest('pty.spawn', {
      env: { ORCA_PANE_KEY: 'tab-context:0' }
    })
    await dispatcher.callRequest('pty.spawn', {})

    const firstEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    const secondEnv = mockPtySpawn.mock.calls[1][2] as { env: Record<string, string> }
    expect(seenContexts[0]).toMatchObject({
      id: 'pty-1',
      paneKey: 'tab-context:0',
      env: { ORCA_PANE_KEY: 'tab-context:0' }
    })
    expect(seenContexts[1]).toMatchObject({ id: 'pty-2', paneKey: undefined })
    expect(firstEnv.env.OVERLAY_ID).toBe('tab-context:0')
    expect(secondEnv.env.OVERLAY_ID).toBe('pty-2')
  })

  it('passes process and renderer env to env augmenters before augmenter overrides are applied', async () => {
    const oldProcessValue = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = '/remote/default-opencode'
    try {
      handler.addEnvAugmenter((ctx) => ({
        SEEN_OPENCODE_CONFIG_DIR: ctx.env.OPENCODE_CONFIG_DIR,
        SEEN_PI_CODING_AGENT_DIR: ctx.env.PI_CODING_AGENT_DIR
      }))

      await dispatcher.callRequest('pty.spawn', {
        env: {
          OPENCODE_CONFIG_DIR: '/remote/renderer-opencode',
          PI_CODING_AGENT_DIR: '/remote/pi'
        }
      })
    } finally {
      if (oldProcessValue === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = oldProcessValue
      }
    }

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnEnv.env.SEEN_OPENCODE_CONFIG_DIR).toBe('/remote/renderer-opencode')
    expect(spawnEnv.env.SEEN_PI_CODING_AGENT_DIR).toBe('/remote/pi')
  })

  it.skipIf(process.platform === 'win32')(
    'wraps bash spawns to restore overlay env after remote startup files',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-pty-shell-launch-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        if (!existsSync('/bin/bash')) {
          return
        }

        handler.addEnvAugmenter(() => ({
          OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          ORCA_OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          PI_CODING_AGENT_DIR: '/remote/overlay/pi',
          ORCA_PI_CODING_AGENT_DIR: '/remote/overlay/pi'
        }))

        await dispatcher.callRequest('pty.spawn', { env: { HOME: homeDir } })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
      }

      const shellArgs = mockPtySpawn.mock.calls[0][1]
      const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
      const rcfile = join(homeDir, '.orca-relay', 'shell-ready', 'bash', 'rcfile')

      expect(shellArgs).toEqual(['--rcfile', rcfile])
      expect(spawnOptions.env.ORCA_OPENCODE_CONFIG_DIR).toBe('/remote/overlay/opencode')
      expect(spawnOptions.env.ORCA_PI_CODING_AGENT_DIR).toBe('/remote/overlay/pi')
      expect(readFileSync(rcfile, 'utf8')).toContain(
        'export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
      )
      expect(readFileSync(rcfile, 'utf8')).toContain(
        'export PI_CODING_AGENT_DIR="${ORCA_PI_CODING_AGENT_DIR}"'
      )

      rmSync(homeDir, { recursive: true, force: true })
    }
  )

  it('revive restores pane identity env alongside hook-server coordinates', async () => {
    await dispatcher.callRequest('pty.spawn', {
      cols: 90,
      rows: 30,
      cwd: '/tmp',
      env: {
        ORCA_PANE_KEY: 'tab-5:1',
        ORCA_TAB_ID: 'tab-5',
        ORCA_WORKTREE_ID: 'wt-5'
      }
    })
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    handler.dispose()
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    handler.addEnvAugmenter(() => ({
      ORCA_AGENT_HOOK_PORT: '12345',
      ORCA_AGENT_HOOK_TOKEN: 'abc-uuid'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.ORCA_PANE_KEY).toBe('tab-5:1')
    expect(callArgs.env.ORCA_TAB_ID).toBe('tab-5')
    expect(callArgs.env.ORCA_WORKTREE_ID).toBe('wt-5')
    expect(callArgs.env.ORCA_AGENT_HOOK_PORT).toBe('12345')
    expect(callArgs.env.ORCA_AGENT_HOOK_TOKEN).toBe('abc-uuid')
  })

  it('invokes the exit listener with the spawn-time paneKey', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', {
      env: { ORCA_PANE_KEY: 'tab-2:1' }
    })
    expect(onExitCb).toBeDefined()
    onExitCb!({ exitCode: 0 })

    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-2:1' }])
  })

  it('immediate shutdown invokes the exit listener once even if onExit arrives later', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', {
      env: { ORCA_PANE_KEY: 'tab-shutdown:0' }
    })
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 0 })

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-shutdown:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('dispose kills all PTYs with SIGKILL and invokes exit listeners', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:0' } })
    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:1' } })
    expect(handler.activePtyCount).toBe(2)

    handler.dispose()
    // Why: dispose uses SIGKILL (not SIGTERM) because the relay process is
    // exiting. A SIGTERM-ignoring remote shell (editor with unsaved buffers,
    // wedged process, uninterruptible sleep) would survive SIGTERM + immediate
    // destroy() as an orphan on the remote host. SIGKILL is not ignorable.
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(exits).toEqual([
      { id: 'pty-1', paneKey: 'tab-dispose:0' },
      { id: 'pty-2', paneKey: 'tab-dispose:1' }
    ])
    expect(handler.activePtyCount).toBe(0)
  })
})
