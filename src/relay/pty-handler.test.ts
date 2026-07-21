/* oxlint-disable max-lines */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'
import * as gitBash from '../main/git-bash'
import * as ptyShellUtils from './pty-shell-utils'
import {
  resolveSetupAgentSequenceLaunchCommand,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
} from '../shared/setup-agent-sequencing'
import { PTY_STARTUP_INGRESS_VERSION } from '../shared/pty-startup-ingress'

const { mockPtySpawn, mockPtyInstance } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
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

import {
  IMMEDIATE_PTY_EXIT_TIMEOUT_MS,
  MAX_RELAY_PTY_SESSIONS,
  PtyHandler,
  attachIdentityMismatches
} from './pty-handler'
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

  afterEach(async () => {
    const cleanup = handler.dispose({ waitForPhysicalExit: false })
    await vi.runAllTimersAsync()
    await cleanup.catch(() => {})
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

  it('allows callers to shorten a grace timer for empty startup relays', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire, 100)

    expect(handler.graceTimerActive).toBe(true)
    vi.advanceTimersByTime(99)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('does not expire an unlimited grace timer', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire, 100)

    expect(handler.graceTimerActive).toBe(true)
    handler.startGraceTimer(onExpire, 0)

    expect(handler.graceTimerActive).toBe(false)
    vi.advanceTimersByTime(100)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('uses the configured grace time for future disconnect timers', () => {
    const onExpire = vi.fn()

    handler.setGraceTimeMs(250)
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(249)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('spawns a PTY and returns an id', async () => {
    const result = await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
    expect(result).toEqual({ id: 'pty-1' })
    expect(mockPtySpawn).toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('normalizes a missing native binding as degraded node-pty availability', async () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error(
        'Failed to load native module: conpty.node, checked: build/Release, prebuilds/win32-x64'
      )
    })

    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'node-pty is not available on this remote host'
    )
    expect(handler.activePtyCount).toBe(0)
  })

  it('preserves unrelated node-pty spawn failures', async () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('File not found: missing-shell.exe')
    })

    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'File not found: missing-shell.exe'
    )
  })

  it('atomically caps concurrent PTY spawn admission', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_RELAY_PTY_SESSIONS + 1 }, () =>
        dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      )
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      MAX_RELAY_PTY_SESSIONS
    )
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'Maximum number of PTY sessions reached (50)' })
    })
    expect(mockPtySpawn).toHaveBeenCalledTimes(MAX_RELAY_PTY_SESSIONS)
    expect(handler.activePtyCount).toBe(MAX_RELAY_PTY_SESSIONS)
  })

  it('spawns a PTY without post-Node-18 array copy methods', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed')
    Reflect.deleteProperty(Array.prototype, 'toReversed')
    try {
      await expect(dispatcher.callRequest('pty.spawn', {})).resolves.toMatchObject({ id: 'pty-1' })
      expect(handler.activePtyCount).toBe(1)
    } finally {
      if (descriptor) {
        Object.defineProperty(Array.prototype, 'toReversed', descriptor)
      }
    }
  })

  it('guards SSH agent terminals after merging the relay inherited Git config', async () => {
    const gitConfigKeys = [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2'
    ] as const
    const saved = Object.fromEntries(gitConfigKeys.map((key) => [key, process.env[key]]))
    process.env.GIT_CONFIG_COUNT = '3'
    process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    process.env.GIT_CONFIG_KEY_1 = 'base.one'
    process.env.GIT_CONFIG_VALUE_1 = 'one'
    process.env.GIT_CONFIG_KEY_2 = 'base.two'
    process.env.GIT_CONFIG_VALUE_2 = 'two'

    try {
      await dispatcher.callRequest('pty.spawn', {
        command: 'claude',
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.proxy',
          GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
        }
      })

      const spawnEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
      expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
      expect(spawnEnv.GIT_CONFIG_COUNT).toBe('3')
      expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('http.proxy')
      expect(spawnEnv.GIT_CONFIG_KEY_1).toBe('credential.interactive')
      expect(spawnEnv.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      expect(spawnEnv.GIT_CONFIG_KEY_3).toBeUndefined()
    } finally {
      for (const key of gitConfigKeys) {
        if (saved[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = saved[key]
        }
      }
    }
  })

  it('guards a trusted SSH agent when its command uses a custom wrapper', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'cd /repo && custom-agent-wrapper',
      launchAgent: 'claude'
    })

    const spawnEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(spawnEnv)).toContain('credential.interactive')
    expect(Object.values(spawnEnv)).toContain('credential.guiPrompt')
  })

  it('leaves an ordinary Windows SSH user terminal unchanged', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      await dispatcher.callRequest('pty.spawn', {
        env: {
          GIT_TERMINAL_PROMPT: '1',
          GCM_INTERACTIVE: 'auto',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.quotePath',
          GIT_CONFIG_VALUE_0: 'false'
        }
      })
      const userEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(userEnv.GIT_TERMINAL_PROMPT).toBe('1')
      expect(userEnv.GCM_INTERACTIVE).toBe('auto')
      expect(userEnv.GIT_CONFIG_COUNT).toBe('1')
      expect(userEnv.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(userEnv.GIT_CONFIG_KEY_1).toBeUndefined()
      const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
      expect(JSON.parse(state)[0]?.gitCredentialPromptGuarded).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('uses an explicit shell override and falls back to the default shell otherwise', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const resolveDefaultShellSpy = vi
      .spyOn(ptyShellUtils, 'resolveDefaultShell')
      .mockReturnValue('/default-shell')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'powershell.exe',
        expect.any(Array),
        expect.any(Object)
      )

      mockPtySpawn.mockClear()

      await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/default-shell',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveDefaultShellSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('ignores Windows shell overrides on non-Windows relay hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    const resolveDefaultShellSpy = vi
      .spyOn(ptyShellUtils, 'resolveDefaultShell')
      .mockReturnValue('/default-shell')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/default-shell',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveDefaultShellSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('rejects unsupported shell overrides on Windows relay hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    try {
      await expect(
        dispatcher.callRequest('pty.spawn', {
          cols: 80,
          rows: 24,
          shellOverride: 'notepad.exe'
        })
      ).rejects.toThrow('Unsupported Windows shell override')
      expect(mockPtySpawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('resolves the Git Bash sentinel to the remote bash.exe path on Windows', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const resolveGitBashSpy = vi
      .spyOn(gitBash, 'resolveWindowsGitBashShellPath')
      .mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe')
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'git-bash'
      })

      expect(resolveGitBashSpy).toHaveBeenCalledWith('git-bash')
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        expect.any(Array),
        expect.any(Object)
      )
    } finally {
      resolveGitBashSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('passes the selected WSL distro to relay launches on Windows', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu-24.04'
      })

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu-24.04'],
        expect.any(Object)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('keeps SSH spawn commands as hints unless provider delivery is requested', async () => {
    await dispatcher.callRequest('pty.spawn', { command: 'echo renderer-owned' })

    vi.advanceTimersByTime(50)

    const term = mockPtySpawn.mock.results[0]?.value
    expect(term.write).not.toHaveBeenCalled()
  })

  it('submits provider-delivered spawn commands to the relay shell', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'echo provider-owned',
      commandDelivery: 'provider'
    })

    vi.advanceTimersByTime(49)
    const term = mockPtySpawn.mock.results[0]?.value
    expect(handler.retainedStartupCommandCount).toBe(1)
    expect(term.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    const submit = process.platform === 'win32' ? '\r' : '\n'
    expect(term.write).toHaveBeenCalledWith(`echo provider-owned${submit}`)
    expect(handler.retainedStartupCommandCount).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'emits shell-ready markers for renderer-delivered startup commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-shell-ready-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo renderer-owned',
          startupCommandDelivery: 'shell-ready'
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_READY_MARKER).toBe('1')
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'emits shell-ready markers for renderer-delivered Codex native prefill commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-codex-prefill-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: "codex --prefill 'linked issue context'"
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_READY_MARKER).toBe('1')
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'enables shell-ready marker env for provider-delivered startup commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-ready-env-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo provider-owned',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_READY_MARKER).toBe('1')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the sequenced startup command hint for provider shell-ready detection',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-sequenced-ready-env-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: {
            HOME: homeDir,
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --prefill 'linked issue context'"
          },
          command: 'bash -lc wait-for-setup-wrapper',
          commandDelivery: 'provider'
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_READY_MARKER).toBe('1')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'waits for the shell-ready marker before provider-delivered startup commands',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-ready-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-ready',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      vi.advanceTimersByTime(1499)
      expect(term.write).not.toHaveBeenCalled()

      dataCallback?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      vi.advanceTimersByTime(49)
      expect(term.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(term.write).toHaveBeenCalledWith('echo after-ready\n')
      expect(handler.retainedStartupCommandCount).toBe(0)
      vi.advanceTimersByTime(8)
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: 'user@remote $ '
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'flushes held shell-ready marker bytes when provider delivery falls back',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-fallback-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo fallback',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
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
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.('\x1b]777;orca-shell-ready')
      vi.advanceTimersByTime(1500)

      expect(term.write).toHaveBeenCalledWith('echo fallback\n')
      vi.advanceTimersByTime(8)
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: '\x1b]777;orca-shell-ready'
      })

      const result = await dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        suppressReplayNotification: true
      })
      expect(result).toEqual({ replay: '\x1b]777;orca-shell-ready' })
    }
  )

  it('reports not-found and reaps a reattach whose backing shell is dead', async () => {
    // Why: a lingering managed entry whose child died without an onExit would
    // otherwise attach-succeed with an empty replay and strand the pane on a
    // black shell. A provably-dead pid must surface as not-found so the SSH
    // provider maps it to SSH_SESSION_EXPIRED and the pane respawns fresh.
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

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dead:0' } })
    expect(handler.activePtyCount).toBe(1)
    expect(onExitCb).toBeDefined()

    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
    try {
      await expect(
        dispatcher.callRequest('pty.attach', { id: 'pty-1', suppressReplayNotification: true })
      ).rejects.toThrow('PTY "pty-1" not found')
    } finally {
      aliveSpy.mockRestore()
    }

    // The stale entry is reaped: cache-eviction observers fire and the map slot
    // is freed so a later attach also cleanly reports not-found.
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-dead:0' }])
    expect(handler.activePtyCount).toBe(0)
    await expect(
      dispatcher.callRequest('pty.attach', { id: 'pty-1', suppressReplayNotification: true })
    ).rejects.toThrow('PTY "pty-1" not found')
  })

  it('settles concurrent immediate shutdown when attach proves the shell exited', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    let shutdown: Promise<unknown> | undefined
    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockImplementation(() => {
      shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
      return false
    })
    try {
      await expect(dispatcher.callRequest('pty.attach', { id: 'pty-1' })).rejects.toThrow(
        'PTY "pty-1" not found'
      )
      await expect(shutdown).resolves.toBeUndefined()
    } finally {
      aliveSpy.mockRestore()
    }

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replays for a reattach whose backing shell is still alive', async () => {
    // Guard the other direction: a live pid must never be reaped, so a quiet
    // but live session still returns its buffered replay on reattach.
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})
    dataCallback?.('prompt$ ')

    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    try {
      const result = await dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        suppressReplayNotification: true
      })
      expect(result).toEqual({ replay: 'prompt$ ' })
    } finally {
      aliveSpy.mockRestore()
    }
    expect(handler.activePtyCount).toBe(1)
  })

  it('terminates spawned PTY when request becomes stale before response', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const term = {
      ...mockPtyInstance,
      kill: killSpy,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    }
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
    expect(handler.activePtyCount).toBe(1)

    onExitCb?.({ exitCode: 137 })
    expect(handler.activePtyCount).toBe(0)
  })

  it('does not submit provider-delivered commands for stale spawn responses', async () => {
    const killSpy = vi.fn()
    const term = { ...mockPtyInstance, kill: killSpy, onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest(
      'pty.spawn',
      { command: 'echo stale', commandDelivery: 'provider' },
      { isStale: () => true }
    )

    vi.advanceTimersByTime(50)
    expect(term.write).not.toHaveBeenCalled()
    expect(handler.retainedStartupCommandCount).toBe(0)
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
  })

  it('releases pending provider-delivered commands on shutdown before delivery', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const term = {
      ...mockPtyInstance,
      kill: killSpy,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest('pty.spawn', {
      command: 'echo stop-before-run',
      commandDelivery: 'provider'
    })
    expect(handler.retainedStartupCommandCount).toBe(1)

    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown
    vi.advanceTimersByTime(50)

    expect(handler.retainedStartupCommandCount).toBe(0)
    expect(term.write).not.toHaveBeenCalled()
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
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello world' })
  })

  it('consumes capable startup queries before relay replay and fanout', async () => {
    let dataCallback: ((data: string) => void) | undefined
    const term = {
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    }
    mockPtySpawn.mockReturnValue(term)
    await dispatcher.callRequest('pty.spawn', {
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })

    const query = '\x1b]10;?\x07'
    dataCallback!(query)
    dataCallback!('prompt')
    vi.advanceTimersByTime(8)

    expect(term.write).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: '',
      rawLength: query.length,
      seq: query.length,
      transformed: true
    })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'prompt' })
    await expect(
      dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        suppressReplayNotification: true
      })
    ).resolves.toEqual({ replay: 'prompt' })
  })

  it('leaves startup queries untouched for an unsupported relay capability version', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', {
        startupIngressVersion: PTY_STARTUP_INGRESS_VERSION - 1,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })

      const query = '\x1b]10;?\x07'
      dataCallback!(query)
      vi.advanceTimersByTime(8)

      expect(term.write).not.toHaveBeenCalled()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: query })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('consumes a color query at a native Windows SSH relay owner', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', { shellOverride: 'powershell.exe' })

      dataCallback!('\x1b]10;?\x07')
      vi.advanceTimersByTime(8)

      expect(term.write).not.toHaveBeenCalled()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: '',
        rawLength: '\x1b]10;?\x07'.length,
        seq: '\x1b]10;?\x07'.length,
        transformed: true
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('forwards color queries from a POSIX SSH relay owner', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      })
      await dispatcher.callRequest('pty.spawn', { shellOverride: '/bin/bash' })
      const query = '\x1b]10;?\x07'

      dataCallback!(query)
      vi.advanceTimersByTime(8)

      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: query })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('keeps renderer color replies for a Windows SSH relay that owns WSL', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', {
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
      const reply = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'

      dataCallback!('\x1b]11;?\x07')
      vi.advanceTimersByTime(8)
      dispatcher.callNotification('pty.data', { id: 'pty-1', data: reply })

      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: '\x1b]11;?\x07'
      })
      expect(term.write).toHaveBeenCalledWith(reply)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('coalesces background PTY output before notifying the client', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('hello ')
    dataCallback!('world')

    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: 'hello world'
    })
  })

  it('sends recent-input redraw output immediately', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'a' })
    dispatcher.notify.mockClear()

    dataCallback!('\x1b[20;2Hredraw')

    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: '\x1b[20;2Hredraw'
    })
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledTimes(1)
  })

  it('drains large relay PTY output in bounded slices', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    const firstChunk = 'x'.repeat(16 * 1024)
    dataCallback!(`${firstChunk}tail`)

    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledTimes(1)
    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: firstChunk
    })

    vi.advanceTimersByTime(1)
    expect(dispatcher.notify).toHaveBeenCalledTimes(2)
    expect(dispatcher.notify).toHaveBeenNthCalledWith(2, 'pty.data', {
      id: 'pty-1',
      data: 'tail'
    })
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
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
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
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })

  it('uses attach identity metadata without exporting it to the shell env', async () => {
    const oldPaneKey = process.env.ORCA_PANE_KEY
    const oldTabId = process.env.ORCA_TAB_ID
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    try {
      await dispatcher.callRequest('pty.spawn', {
        env: { FOO: 'bar' },
        paneKey: 'tab-a:leaf-a',
        tabId: 'tab-a'
      })
    } finally {
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }

    const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOptions.env.ORCA_PANE_KEY).toBeUndefined()
    expect(spawnOptions.env.ORCA_TAB_ID).toBeUndefined()

    await expect(
      dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        expectedPaneKey: 'tab-b:leaf-b',
        expectedTabId: 'tab-b'
      })
    ).rejects.toThrow('PTY "pty-1" not found')

    await expect(
      dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        expectedPaneKey: 'tab-a:leaf-a',
        expectedTabId: 'tab-a'
      })
    ).resolves.toEqual({})
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

  it('flushes pending PTY output before notifying exit', async () => {
    let dataCallback: ((data: string) => void) | undefined
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCallback = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('final output')
    exitCallback!({ exitCode: 0 })

    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: 'final output'
    })
    expect(dispatcher.notify).toHaveBeenNthCalledWith(2, 'pty.exit', { id: 'pty-1', code: 0 })
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

  it('reports the PTY grid actually applied by node-pty', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      cols: 132,
      rows: 43,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    await expect(dispatcher.callRequest('pty.getSize', { id: spawned.id })).resolves.toEqual({
      cols: 132,
      rows: 43
    })
    await expect(dispatcher.callRequest('pty.getSize', { id: 'missing' })).resolves.toBeNull()
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

  // Why: node-pty's Windows agent throws "Signals not supported on windows."
  // for any signal argument. killPtyProcess drops the signal on win32 — cover
  // every call site so a future regression cannot reintroduce signal args.
  describe('kills PTY without a signal on Windows', () => {
    async function withWindowsPlatform(fn: () => Promise<void>): Promise<void> {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        await fn()
      } finally {
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: originalPlatform
        })
      }
    }

    function mockKillablePty(): ReturnType<typeof vi.fn> {
      const mockKill = vi.fn()
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        kill: mockKill,
        onData: vi.fn(),
        onExit: vi.fn()
      })
      return mockKill
    }

    function expectBareKills(mockKill: ReturnType<typeof vi.fn>, times: number): void {
      expect(mockKill).toHaveBeenCalledTimes(times)
      expect(mockKill.mock.calls.every((args) => args.length === 0)).toBe(true)
    }

    it('on graceful shutdown', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        expectBareKills(mockKill, 1)
      })
    })

    it('on immediate shutdown', async () => {
      await withWindowsPlatform(async () => {
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
        await dispatcher.callRequest('pty.spawn', {})
        const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
        onExitCb!({ exitCode: 137 })
        await shutdown
        expectBareKills(mockKill, 1)
      })
    })

    it('does not double-kill when immediate cleanup joins graceful shutdown', async () => {
      await withWindowsPlatform(async () => {
        let onExitCb: ((evt: { exitCode: number }) => void) | undefined
        const mockKill = vi.fn()
        const destroy = vi.fn()
        mockPtySpawn.mockReturnValue({
          ...mockPtyInstance,
          kill: mockKill,
          destroy,
          onData: vi.fn(),
          onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
            onExitCb = cb
          })
        })
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        const immediate = dispatcher.callRequest('pty.shutdown', {
          id: 'pty-1',
          immediate: true
        })

        expectBareKills(mockKill, 1)
        onExitCb!({ exitCode: 137 })
        await immediate
        expectBareKills(mockKill, 1)
        expect(destroy).not.toHaveBeenCalled()
      })
    })

    it('does not retry stale-spawn cleanup after the Windows kill deadline', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest('pty.spawn', {}, { isStale: () => true })
        expectBareKills(mockKill, 1)
        vi.advanceTimersByTime(5000)
        expectBareKills(mockKill, 1)
      })
    })

    it('does not retry graceful shutdown after the Windows kill deadline', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = mockKillablePty()
        await dispatcher.callRequest('pty.spawn', {})
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
        expectBareKills(mockKill, 1)
        vi.advanceTimersByTime(5000)
        expectBareKills(mockKill, 1)
      })
    })

    it('on dispose', async () => {
      await withWindowsPlatform(async () => {
        const mockKill = vi.fn()
        const destroy = vi.fn()
        mockPtySpawn.mockReturnValue({
          ...mockPtyInstance,
          kill: mockKill,
          destroy,
          onData: vi.fn(),
          onExit: vi.fn()
        })
        await dispatcher.callRequest('pty.spawn', {})
        await handler.dispose({ waitForPhysicalExit: false })
        expectBareKills(mockKill, 1)
        expect(destroy).not.toHaveBeenCalled()
      })
    })
  })

  it('flushes pending PTY output before immediate shutdown cleanup', async () => {
    let dataCallback: ((data: string) => void) | undefined
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('last words')
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown

    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: 'last words'
    })
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
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

    expect(handler.activePtyCount).toBe(1)
    expect(exits).toEqual([])
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
    onExitCb!({ exitCode: 137 })

    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: 137 })
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-fallback:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('retries a rejected graceful SIGKILL fallback while retaining ownership', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ === 0) {
        throw new Error('transient kill failure')
      }
    })
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    vi.advanceTimersByTime(5000)

    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    vi.runOnlyPendingTimers()
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills PTY on shutdown with SIGKILL when immediate', async () => {
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

    await dispatcher.callRequest('pty.spawn', {})
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('throws for attach on nonexistent PTY', async () => {
    await expect(dispatcher.callRequest('pty.attach', { id: 'pty-999' })).rejects.toThrow(
      'PTY "pty-999" not found'
    )
  })

  it('default grace timer does not expire', () => {
    const onExpire = vi.fn()

    handler.startGraceTimer(onExpire)

    expect(handler.graceTimerActive).toBe(false)
    vi.advanceTimersByTime(DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('configured grace timer waits full period even when no PTYs exist', () => {
    const onExpire = vi.fn()
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(boundedGraceMs - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
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
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(boundedGraceMs - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
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
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(60_000)
    handler.cancelGraceTimer()

    vi.advanceTimersByTime(boundedGraceMs)
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

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.SEEN_OPENCODE_CONFIG_DIR).toBe('/remote/renderer-opencode')
    expect(spawnEnv.env.SEEN_PI_CODING_AGENT_DIR).toBe('/remote/pi')
  })

  it('applies identity defaults, then deletions, while preserving explicit TERM', async () => {
    handler.addEnvAugmenter(() => ({
      TERM: 'augmenter-term',
      TERM_PROGRAM: 'augmenter-terminal',
      ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/augmenter-attribution'
    }))

    await dispatcher.callRequest('pty.spawn', {
      env: {
        TERM: 'screen-256color',
        TERM_PROGRAM: 'renderer-terminal',
        ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/renderer-attribution'
      },
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('screen-256color')
    expect(spawnEnv.env.TERM).toBe('screen-256color')
    expect(spawnEnv.env.COLORTERM).toBe('truecolor')
    expect(spawnEnv.env.FORCE_HYPERLINK).toBe('1')
    expect(spawnEnv.env.TERM_PROGRAM).toBeUndefined()
    expect(spawnEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
  })

  it('replaces an ambient TERM=dumb when no explicit TERM is supplied', async () => {
    const previousTerm = process.env.TERM
    process.env.TERM = 'dumb'
    try {
      await dispatcher.callRequest('pty.spawn', {})
    } finally {
      if (previousTerm === undefined) {
        delete process.env.TERM
      } else {
        process.env.TERM = previousTerm
      }
    }

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.TERM).toBe('xterm-256color')
    expect(spawnEnv.env.TERM_PROGRAM).toBe('Orca')
  })

  it('uses the safe terminal default when TERM is deleted without a custom value', async () => {
    await dispatcher.callRequest('pty.spawn', {
      envToDelete: ['TERM']
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.TERM).toBe('xterm-256color')
  })

  it('admits default-cwd spawns through the worktree removal coordinator', async () => {
    const finishCreation = vi.fn()
    const beginWorktreePtySpawn = vi.fn((_operationPath: string) => finishCreation)
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })

    await dispatcher.callRequest('pty.spawn', {})

    expect(beginWorktreePtySpawn).toHaveBeenCalledWith(expect.any(String))
    expect(beginWorktreePtySpawn.mock.calls[0][0]).not.toBe('')
    expect(finishCreation).toHaveBeenCalledTimes(1)
  })

  it('fences both sibling worktree identity and removing cwd with rollback', async () => {
    const finishSiblingAdmission = vi.fn()
    const beginWorktreePtySpawn = vi.fn((operationPath: string) => {
      if (operationPath === '/repo/removing/nested') {
        throw new Error('Remote worktree deletion already in progress')
      }
      return finishSiblingAdmission
    })
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })

    await expect(
      dispatcher.callRequest('pty.spawn', {
        cwd: '/repo/removing/nested',
        env: { ORCA_WORKTREE_ID: 'repo-id::/repo/sibling' }
      })
    ).rejects.toThrow('Remote worktree deletion already in progress')

    expect(beginWorktreePtySpawn.mock.calls.map(([operationPath]) => operationPath)).toEqual([
      '/repo/sibling',
      '/repo/removing/nested'
    ])
    expect(finishSiblingAdmission).toHaveBeenCalledOnce()
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('lets relay env augmenters resolve the original sequenced startup command hint', async () => {
    handler.addEnvAugmenter((ctx) => ({
      SEEN_LAUNCH_COMMAND_HINT: resolveSetupAgentSequenceLaunchCommand(ctx.env, ctx.command) ?? ''
    }))

    await dispatcher.callRequest('pty.spawn', {
      command: 'powershell wait-wrapper',
      env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume' }
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnEnv.env.SEEN_LAUNCH_COMMAND_HINT).toBe('omp --resume')
  })

  it.skipIf(process.platform === 'win32')(
    'wraps bash spawns to restore overlay env after remote startup files',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const oldOrcaPi = process.env.ORCA_PI_CODING_AGENT_DIR
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-pty-shell-launch-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      delete process.env.ORCA_PI_CODING_AGENT_DIR
      try {
        if (!existsSync('/bin/bash')) {
          return
        }

        handler.addEnvAugmenter(() => ({
          OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          ORCA_OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          ORCA_OMP_STATUS_EXTENSION: '/remote/.omp/agent/extensions/orca-agent-status.ts'
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
        if (oldOrcaPi === undefined) {
          delete process.env.ORCA_PI_CODING_AGENT_DIR
        } else {
          process.env.ORCA_PI_CODING_AGENT_DIR = oldOrcaPi
        }
      }

      const shellArgs = mockPtySpawn.mock.calls[0][1]
      const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
      const rcfile = join(homeDir, '.orca-relay', 'shell-ready', 'bash', 'rcfile')

      expect(shellArgs).toEqual(['--rcfile', rcfile])
      expect(spawnOptions.env.ORCA_OPENCODE_CONFIG_DIR).toBe('/remote/overlay/opencode')
      expect(spawnOptions.env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(readFileSync(rcfile, 'utf8')).toContain(
        'export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
      )
      expect(readFileSync(rcfile, 'utf8')).not.toContain('ORCA_PI_CODING_AGENT_DIR')
      expect(readFileSync(rcfile, 'utf8')).toContain('command omp --extension')

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

    await handler.dispose({ waitForPhysicalExit: false })
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
    expect(callArgs.env.TERM).toBe('xterm-256color')
    expect(callArgs.env.TERM_PROGRAM).toBe('Orca')
  })

  it('fences both revived worktree identity and cwd with rollback', async () => {
    const finishSiblingAdmission = vi.fn()
    const beginWorktreePtySpawn = vi.fn((operationPath: string) => {
      if (operationPath === '/repo/removing/nested') {
        throw new Error('Remote worktree deletion already in progress')
      }
      return finishSiblingAdmission
    })
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: '/repo/removing/nested',
        worktreeId: 'repo-id::/repo/sibling'
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(dispatcher.callRequest('pty.revive', { state })).rejects.toThrow(
        'Remote worktree deletion already in progress'
      )
    } finally {
      killSpy.mockRestore()
    }

    expect(beginWorktreePtySpawn.mock.calls.map(([operationPath]) => operationPath)).toEqual([
      '/repo/sibling',
      '/repo/removing/nested'
    ])
    expect(finishSiblingAdmission).toHaveBeenCalledOnce()
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('applies the physical PTY cap to untrusted revive state', async () => {
    const state = JSON.stringify(
      Array.from({ length: MAX_RELAY_PTY_SESSIONS + 1 }, (_, index) => ({
        id: `pty-${index + 1}`,
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: '/repo',
        worktreeId: 'repo-id::/repo'
      }))
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(dispatcher.callRequest('pty.revive', { state })).rejects.toThrow(
        'Maximum number of PTY sessions reached (50)'
      )
    } finally {
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(MAX_RELAY_PTY_SESSIONS)
    expect(handler.activePtyCount).toBe(MAX_RELAY_PTY_SESSIONS)
  })

  it('deduplicates concurrent revive requests for the same physical PTY id', async () => {
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: '/repo',
        worktreeId: 'repo-id::/repo'
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await Promise.all([
        dispatcher.callRequest('pty.revive', { state }),
        dispatcher.callRequest('pty.revive', { state })
      ])
    } finally {
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    expect(handler.activePtyCount).toBe(1)
  })

  it('revive preserves the credential guard chosen for an SSH agent terminal', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'claude'
    })
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
    expect(JSON.parse(state)[0]?.gitCredentialPromptGuarded).toBe(true)

    handler.dispose()
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(revivedEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(revivedEnv.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(revivedEnv)).toContain('credential.interactive')
    expect(Object.values(revivedEnv)).toContain('credential.guiPrompt')
  })

  it('revive treats legacy relay state as an ordinary unguarded terminal', async () => {
    const savedTerminalPrompt = process.env.GIT_TERMINAL_PROMPT
    const savedGcmInteractive = process.env.GCM_INTERACTIVE
    delete process.env.GIT_TERMINAL_PROMPT
    delete process.env.GCM_INTERACTIVE
    const state = JSON.stringify([
      {
        id: 'pty-legacy',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd()
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await dispatcher.callRequest('pty.revive', { state })
      const revivedEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(revivedEnv.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(revivedEnv.GCM_INTERACTIVE).toBeUndefined()
    } finally {
      killSpy.mockRestore()
      if (savedTerminalPrompt === undefined) {
        delete process.env.GIT_TERMINAL_PROMPT
      } else {
        process.env.GIT_TERMINAL_PROMPT = savedTerminalPrompt
      }
      if (savedGcmInteractive === undefined) {
        delete process.env.GCM_INTERACTIVE
      } else {
        process.env.GCM_INTERACTIVE = savedGcmInteractive
      }
    }
  })

  it('normalizes an explicit empty TERM and preserves sanitized env deletions on revive', async () => {
    await dispatcher.callRequest('pty.spawn', {
      env: { TERM: '' },
      envToDelete: ['ORCA_ATTRIBUTION_SHIM_DIR', '', 42]
    })

    const initialEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(initialEnv.name).toBe('xterm-256color')
    expect(initialEnv.env.TERM).toBe('xterm-256color')

    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
    const [serialized] = JSON.parse(state) as {
      explicitTerm?: string
      envToDelete?: string[]
    }[]
    expect(serialized.explicitTerm).toBeUndefined()
    expect(serialized.envToDelete).toEqual(['ORCA_ATTRIBUTION_SHIM_DIR'])

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    handler.addEnvAugmenter(() => ({
      ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/revived-attribution'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(revivedEnv.name).toBe('xterm-256color')
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
  })

  it('drops legacy empty explicit TERM metadata after revive', async () => {
    const state = JSON.stringify([
      {
        id: 'pty-8',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        explicitTerm: '',
        envToDelete: ['ORCA_ATTRIBUTION_SHIM_DIR']
      }
    ])
    handler.addEnvAugmenter(() => ({
      ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/legacy-empty-attribution'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(revivedEnv.name).toBe('xterm-256color')
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()

    const serializedState = (await dispatcher.callRequest('pty.serialize', {
      ids: ['pty-8']
    })) as string
    const [serialized] = JSON.parse(serializedState) as {
      explicitTerm?: string
      envToDelete?: string[]
    }[]
    expect(serialized.explicitTerm).toBeUndefined()
    expect(serialized.envToDelete).toEqual(['ORCA_ATTRIBUTION_SHIM_DIR'])
  })

  it('preserves explicit TERM and env deletions through repeated revive cycles', async () => {
    await dispatcher.callRequest('pty.spawn', {
      env: { TERM: 'screen-256color' },
      envToDelete: ['ORCA_ATTRIBUTION_SHIM_DIR']
    })
    let state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
      handler.addEnvAugmenter(() => ({
        ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/first-revive'
      }))
      await dispatcher.callRequest('pty.revive', { state })

      const firstRevivedEnv = mockPtySpawn.mock.calls[0][2] as {
        name: string
        env: Record<string, string>
      }
      expect(firstRevivedEnv.name).toBe('screen-256color')
      expect(firstRevivedEnv.env.TERM).toBe('screen-256color')
      expect(firstRevivedEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
      state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
      expect(JSON.parse(state)).toMatchObject([
        {
          explicitTerm: 'screen-256color',
          envToDelete: ['ORCA_ATTRIBUTION_SHIM_DIR']
        }
      ])

      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
      handler.addEnvAugmenter(() => ({
        ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/second-revive'
      }))
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const secondRevivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(secondRevivedEnv.name).toBe('screen-256color')
    expect(secondRevivedEnv.env.TERM).toBe('screen-256color')
    expect(secondRevivedEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
  })

  it('revives legacy serialized entries with default TERM and no env deletions', async () => {
    handler.addEnvAugmenter(() => ({
      ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/legacy-attribution'
    }))
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd()
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_ATTRIBUTION_SHIM_DIR).toBe('/tmp/legacy-attribution')
  })

  it('revive preserves attach identity metadata without exporting hook identity env', async () => {
    const oldPaneKey = process.env.ORCA_PANE_KEY
    const oldTabId = process.env.ORCA_TAB_ID
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 90,
        rows: 30,
        cwd: '/tmp',
        env: { FOO: 'bar' },
        paneKey: 'tab-5:leaf-5',
        tabId: 'tab-5'
      })
    } finally {
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }

    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.ORCA_PANE_KEY).toBeUndefined()
    expect(callArgs.env.ORCA_TAB_ID).toBeUndefined()

    await expect(
      dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        expectedPaneKey: 'tab-other:leaf',
        expectedTabId: 'tab-other'
      })
    ).rejects.toThrow('PTY "pty-1" not found')
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

  it('keeps immediate shutdown pending until onExit and invokes the exit listener once', async () => {
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
    let settled = false
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    void shutdown.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(exits).toEqual([])
    expect(handler.activePtyCount).toBe(1)
    onExitCb!({ exitCode: 0 })
    await shutdown

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-shutdown:0' }])
    expect(handler.activePtyCount).toBe(0)
  })

  it('physically stops only matching worktree PTYs before relay deletion', async () => {
    let firstExit: ((evt: { exitCode: number }) => void) | undefined
    let secondExit: ((evt: { exitCode: number }) => void) | undefined
    const firstKill = vi.fn()
    const secondKill = vi.fn()
    mockPtySpawn
      .mockReturnValueOnce({
        ...mockPtyInstance,
        kill: firstKill,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          firstExit = cb
        })
      })
      .mockReturnValueOnce({
        ...mockPtyInstance,
        kill: secondKill,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          secondExit = cb
        })
      })

    await dispatcher.callRequest('pty.spawn', {
      cwd: '/repo',
      env: { ORCA_WORKTREE_ID: 'repo-id::/repo' }
    })
    await dispatcher.callRequest('pty.spawn', {
      cwd: '/sibling',
      env: { ORCA_WORKTREE_ID: 'repo-id::/sibling' }
    })

    let settled = false
    const shutdown = handler.shutdownForWorktreePath('/repo').finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(firstKill).toHaveBeenCalledWith('SIGKILL')
    expect(secondKill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(handler.activePtyCount).toBe(2)

    firstExit?.({ exitCode: 137 })
    await shutdown
    expect(secondExit).toBeDefined()
    expect(handler.activePtyCount).toBe(1)
  })

  it('rejects timed-out immediate shutdown while retaining the physical owner', async () => {
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

    await dispatcher.callRequest('pty.spawn', {})
    const shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    const rejected = expect(shutdown).rejects.toThrow('Timed out waiting for PTY process exit')
    await vi.advanceTimersByTimeAsync(IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
    await rejected

    expect(mockKill).toHaveBeenCalledTimes(1)
    expect(handler.activePtyCount).toBe(1)
    const retry = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    expect(mockKill).toHaveBeenCalledTimes(1)
    onExitCb!({ exitCode: 137 })
    await retry
    expect(handler.activePtyCount).toBe(0)
  })

  it('fences late creation and drains an admitted spawn before the disposal snapshot', async () => {
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

    const admittedSpawn = dispatcher.callRequest('pty.spawn', {})
    const dispose = handler.dispose()
    await admittedSpawn

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(1)
    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'PTY handler is shutting down'
    )
    const aliveSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(
        dispatcher.callRequest('pty.revive', {
          state: JSON.stringify([
            { id: 'pty-late', pid: process.pid, cols: 80, rows: 24, cwd: '/tmp' }
          ])
        })
      ).rejects.toThrow('PTY handler is shutting down')
    } finally {
      aliveSpy.mockRestore()
    }

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(handler.dispose()).toBe(dispose)
  })

  it('retries a rejected force kill during dispose and waits for physical exit', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ === 0) {
        throw new Error('transient dispose kill failure')
      }
    })
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    const dispose = handler.dispose()
    await Promise.resolve()

    expect(mockKill.mock.calls).toEqual([['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(mockKill.mock.calls).toEqual([['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes ownership when dispose overlaps a queued graceful force-kill retry', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    let forceAttempts = 0
    const mockKill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL' && forceAttempts++ < 2) {
        throw new Error('transient overlapping kill failure')
      }
    })
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    vi.advanceTimersByTime(5000)
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(1)

    const dispose = handler.dispose()
    await Promise.resolve()
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(mockKill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL'], ['SIGKILL']])
    expect(handler.activePtyCount).toBe(1)

    onExitCb!({ exitCode: 137 })
    await dispose
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose kills all PTYs with SIGKILL and invokes exit listeners', async () => {
    const mockKill = vi.fn()
    const onExitCallbacks: ((evt: { exitCode: number }) => void)[] = []
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCallbacks.push(cb)
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:0' } })
    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dispose:1' } })
    expect(handler.activePtyCount).toBe(2)

    const dispose = handler.dispose()
    await Promise.resolve()
    // Why: dispose uses SIGKILL (not SIGTERM) because the relay process is
    // exiting. A SIGTERM-ignoring remote shell (editor with unsaved buffers,
    // wedged process, uninterruptible sleep) would survive SIGTERM + immediate
    // destroy() as an orphan on the remote host. SIGKILL is not ignorable.
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(2)
    for (const onExit of onExitCallbacks) {
      onExit({ exitCode: 137 })
    }
    await dispose
    expect(exits).toEqual([
      { id: 'pty-1', paneKey: 'tab-dispose:0' },
      { id: 'pty-2', paneKey: 'tab-dispose:1' }
    ])
    expect(handler.activePtyCount).toBe(0)
  })
})

describe('attachIdentityMismatches', () => {
  it('rejects a paneKey collision across relay generations', () => {
    // Old lease expects tab-a's pane; the reset relay's pty-1 belongs to tab-b.
    expect(
      attachIdentityMismatches({ paneKey: 'tab-a:0' }, { paneKey: 'tab-b:0', tabId: 'tab-b' })
    ).toBe(true)
  })

  it('rejects a tabId collision when only tab identity is known', () => {
    expect(attachIdentityMismatches({ tabId: 'tab-a' }, { tabId: 'tab-b' })).toBe(true)
  })

  it('accepts a matching identity', () => {
    expect(
      attachIdentityMismatches(
        { paneKey: 'tab-a:0', tabId: 'tab-a' },
        { paneKey: 'tab-a:0', tabId: 'tab-a' }
      )
    ).toBe(false)
  })

  it('stays permissive when the caller supplies no identity', () => {
    expect(attachIdentityMismatches({}, { paneKey: 'tab-a:0', tabId: 'tab-a' })).toBe(false)
  })

  it('stays permissive when the managed PTY predates identity capture', () => {
    expect(attachIdentityMismatches({ paneKey: 'tab-a:0', tabId: 'tab-a' }, {})).toBe(false)
  })

  it('does not reject on tabId when paneKey matches (split panes share a tab)', () => {
    expect(
      attachIdentityMismatches({ paneKey: 'tab-a:1' }, { paneKey: 'tab-a:1', tabId: 'tab-a' })
    ).toBe(false)
  })
})
