/* eslint-disable max-lines -- Why: PTY spawn env behavior is easiest to verify in
one focused file because the registration helper is stateful and each spawn-path
assertion reuses the same mocked IPC and node-pty harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  chmodSyncMock,
  getPathMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  piBuildPtyEnvMock,
  piClearPtyMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  chmodSyncMock: vi.fn(),
  getPathMock: vi.fn(),
  spawnMock: vi.fn(),
  openCodeBuildPtyEnvMock: vi.fn(),
  openCodeClearPtyMock: vi.fn(),
  piBuildPtyEnvMock: vi.fn(),
  piClearPtyMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: chmodSyncMock,
  constants: {
    X_OK: 1
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: {
    buildPtyEnv: openCodeBuildPtyEnvMock,
    clearPty: openCodeClearPtyMock
  }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: {
    buildPtyEnv: piBuildPtyEnvMock,
    clearPty: piClearPtyMock
  }
}))
import { registerPtyHandlers, registerSshPtyProvider, unregisterSshPtyProvider } from './pty'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('registerPtyHandlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn()
    }
  }

  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG_DIR
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    accessSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    chmodSyncMock.mockReset()
    getPathMock.mockReset()
    spawnMock.mockReset()
    openCodeBuildPtyEnvMock.mockReset()
    openCodeClearPtyMock.mockReset()
    piBuildPtyEnvMock.mockReset()
    piClearPtyMock.mockReset()
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()

    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    getPathMock.mockReturnValue('/tmp/orca-user-data')
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    openCodeBuildPtyEnvMock.mockReturnValue({
      ORCA_OPENCODE_HOOK_PORT: '4567',
      ORCA_OPENCODE_HOOK_TOKEN: 'opencode-token',
      ORCA_OPENCODE_PTY_ID: 'test-pty',
      OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-config'
    })
    piBuildPtyEnvMock.mockImplementation((_ptyId: string, existingAgentDir?: string) => ({
      PI_CODING_AGENT_DIR: existingAgentDir
        ? '/tmp/orca-pi-agent-overlay'
        : '/tmp/orca-pi-agent-overlay'
    }))
    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    })
  })

  afterEach(() => {
    unregisterSshPtyProvider('ssh-1')
  })

  function createMockProc() {
    let dataHandler: ((data: string) => void) | null = null
    let exitHandler: ((event: { exitCode: number }) => void) | null = null

    return {
      proc: {
        onData: vi.fn((handler: (data: string) => void) => {
          dataHandler = handler
          return makeDisposable()
        }),
        onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
          exitHandler = handler
          return makeDisposable()
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn()
      },
      emitData(data: string) {
        dataHandler?.(data)
      },
      emitExit(exitCode = 0) {
        exitHandler?.({ exitCode })
      }
    }
  }

  /** Helper: trigger pty:spawn and return the env passed to node-pty. */
  async function spawnAndGetEnv(
    argsEnv?: Record<string, string>,
    processEnvOverrides?: Record<string, string | undefined>,
    getSelectedCodexHomePath?: () => string | null
  ): Promise<Record<string, string>> {
    const savedEnv: Record<string, string | undefined> = {}
    if (processEnvOverrides) {
      for (const [k, v] of Object.entries(processEnvOverrides)) {
        savedEnv[k] = process.env[k]
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }

    try {
      // Clear previously registered handlers so re-registration doesn't
      // accumulate stale state across calls within one test.
      handlers.clear()
      registerPtyHandlers(mainWindow as never, undefined, getSelectedCodexHomePath)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        ...(argsEnv ? { env: argsEnv } : {})
      })
      const spawnCall = spawnMock.mock.calls.at(-1)!
      return spawnCall[2].env as Record<string, string>
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  }

  function spawnAndGetCall(args?: {
    cwd?: string
    env?: Record<string, string>
    command?: string
  }): [string, string[], { cwd: string; env: Record<string, string> }] {
    handlers.clear()
    registerPtyHandlers(mainWindow as never)
    handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      ...args
    })
    return spawnMock.mock.calls.at(-1) as [
      string,
      string[],
      { cwd: string; env: Record<string, string> }
    ]
  }

  describe('spawn environment', () => {
    it('defaults LANG to en_US.UTF-8 when not inherited from process.env', async () => {
      const env = await spawnAndGetEnv(undefined, { LANG: undefined })
      expect(env.LANG).toBe('en_US.UTF-8')
    })

    it('inherits LANG from process.env when already set', async () => {
      const env = await spawnAndGetEnv(undefined, { LANG: 'ja_JP.UTF-8' })
      expect(env.LANG).toBe('ja_JP.UTF-8')
    })

    it('lets caller-provided env override LANG', async () => {
      const env = await spawnAndGetEnv({ LANG: 'fr_FR.UTF-8' })
      expect(env.LANG).toBe('fr_FR.UTF-8')
    })

    it('always sets TERM and COLORTERM regardless of env', async () => {
      const env = await spawnAndGetEnv()
      expect(env.TERM).toBe('xterm-256color')
      expect(env.COLORTERM).toBe('truecolor')
      expect(env.TERM_PROGRAM).toBe('Orca')
    })

    it('injects the selected Codex home into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, () => '/tmp/orca-codex-home')
      expect(env.CODEX_HOME).toBe('/tmp/orca-codex-home')
    })

    it('injects the OpenCode hook env into Orca terminal PTYs', async () => {
      // Why: clear any ambient OPENCODE_CONFIG_DIR so the mock's value is used
      const env = await spawnAndGetEnv(undefined, { OPENCODE_CONFIG_DIR: undefined })
      expect(openCodeBuildPtyEnvMock).toHaveBeenCalledTimes(1)
      expect(openCodeBuildPtyEnvMock.mock.calls[0]?.[0]).toEqual(expect.any(String))
      expect(env.ORCA_OPENCODE_HOOK_PORT).toBe('4567')
      expect(env.ORCA_OPENCODE_HOOK_TOKEN).toBe('opencode-token')
      expect(env.ORCA_OPENCODE_PTY_ID).toBe('test-pty')
      expect(env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
    })

    it('injects the Pi agent overlay env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv(undefined, { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' })
      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), '/tmp/user-pi-agent')
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/orca-pi-agent-overlay')
    })
    it('leaves ambient CODEX_HOME untouched when system default is selected', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => null
      )
      expect(env.CODEX_HOME).toBe('/tmp/system-codex-home')
    })
  })

  it('lists sessions from both local and SSH providers', async () => {
    registerPtyHandlers(mainWindow as never)
    const sshListProcesses = vi.fn(async () => [
      { id: 'remote-pty', cwd: '/remote', title: 'ssh-shell' }
    ])
    const sshShutdown = vi.fn(async () => undefined)
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: sshListProcesses,
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })
    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      cwd: string
      title: string
    }[]

    expect(sshListProcesses).toHaveBeenCalled()
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: '/remote', id: 'remote-pty', title: 'ssh-shell' })
      ])
    )

    await handlers.get('pty:kill')!(null, { id: 'remote-pty' })
    expect(sshShutdown).toHaveBeenCalledWith('remote-pty', true)
  })

  describe('Windows UTF-8 code page', () => {
    let originalPlatform: string
    let originalComspec: string | undefined

    beforeEach(() => {
      originalPlatform = process.platform
      originalComspec = process.env.COMSPEC
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      process.env.USERPROFILE = 'C:\\Users\\test'
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComspec === undefined) {
        delete process.env.COMSPEC
      } else {
        process.env.COMSPEC = originalComspec
      }
      delete process.env.PYTHONUTF8
    })

    it('passes chcp 65001 to cmd.exe for UTF-8 console output', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })

    it('sets Console encoding for powershell.exe', () => {
      process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        [
          '-NoExit',
          '-Command',
          'try { . $PROFILE } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8'
        ],
        expect.any(Object)
      )
    })

    it('sets Console encoding for pwsh.exe', () => {
      process.env.COMSPEC = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        [
          '-NoExit',
          '-Command',
          'try { . $PROFILE } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8'
        ],
        expect.any(Object)
      )
    })

    it('sets PYTHONUTF8=1 in the spawn environment on Windows', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('1')
    })

    it('does not override an existing PYTHONUTF8 value', () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      process.env.PYTHONUTF8 = '0'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('0')
    })

    it('passes no encoding args for unrecognized shells', () => {
      process.env.COMSPEC = 'C:\\Program Files\\Git\\bin\\bash.exe'

      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        [],
        expect.any(Object)
      )
    })
  })

  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', async () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    existsSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing') {
        return false
      }
      return true
    })

    try {
      registerPtyHandlers(mainWindow as never)

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing'
        })
      ).rejects.toThrow(
        'Working directory "\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing" does not exist.'
      )
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
    }
  })

  it('spawns a plain POSIX login shell and queues startup commands for the live session', () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL
    const originalZdotdir = process.env.ZDOTDIR

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'
    delete process.env.ZDOTDIR

    try {
      const [shell, args, options] = spawnAndGetCall({ cwd: '/tmp', command: 'printf "hello"' })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.ZDOTDIR).toBe('/tmp/orca-user-data/shell-ready/zsh')
      expect(options.env.ORCA_ORIG_ZDOTDIR).toBe(process.env.HOME)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
      if (originalZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = originalZdotdir
      }
    }
  })

  it('does not force ~/.bashrc after sourcing bash login files in the shell-ready rcfile', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/bash'

    try {
      spawnAndGetCall({ cwd: '/tmp', command: 'echo hello' })

      const { getBashShellReadyRcfileContent } = await import('./pty')
      const bashRcContent = getBashShellReadyRcfileContent()
      expect(bashRcContent).toContain('source "$HOME/.bash_profile"')
      expect(bashRcContent).not.toContain('source "$HOME/.bashrc"')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('does not write the startup command before the shell-ready marker arrives', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'claude'
      })

      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('last login: today\r\n')
      vi.runOnlyPendingTimers()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]133;A\x07% ')
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('claude\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a max wait when the shell emits no readiness output', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'codex'
      })

      vi.advanceTimersByTime(1500)
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a system shell when SHELL points to a missing binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    existsSyncMock.mockImplementation(
      (targetPath: string) => targetPath !== '/opt/homebrew/bin/bash'
    )

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      expect(result).toEqual({ id: expect.any(String) })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({ cwd: '/tmp' })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Primary shell "/opt/homebrew/bin/bash" failed')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('falls back when SHELL points to a non-executable binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    accessSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '/opt/homebrew/bin/bash') {
        throw new Error('permission denied')
      }
    })

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({ cwd: '/tmp' })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shell "/opt/homebrew/bin/bash" is not executable')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('prefers args.env.SHELL and normalizes the child env after fallback', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    existsSyncMock.mockImplementation(
      (targetPath: string) => targetPath !== '/opt/homebrew/bin/bash'
    )

    try {
      process.env.SHELL = '/bin/bash'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: { SHELL: '/opt/homebrew/bin/bash' }
      })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({ SHELL: '/bin/zsh' })
        })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Primary shell "/opt/homebrew/bin/bash" failed')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('cleans up provider-specific PTY overlays when a PTY is killed', async () => {
    let exitCb: ((info: { exitCode: number }) => void) | undefined
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return makeDisposable()
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        // Simulate node-pty behavior: kill triggers onExit callback
        exitCb?.({ exitCode: -1 })
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })

  it('disposes PTY listeners before manual kill IPC', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
  })

  it('disposes PTY listeners before runtime controller kill', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const runtimeController = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
    }

    expect(runtimeController.kill(spawnResult.id)).toBe(true)
    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
  })

  it('disposes PTY listeners before did-finish-load orphan cleanup', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const proc = {
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    }
    const runtime = {
      setPtyController: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never, runtime as never)
    const didFinishLoad = mainWindow.webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'did-finish-load'
    )?.[1] as (() => void) | undefined
    expect(didFinishLoad).toBeTypeOf('function')
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // The first load after spawn only advances generation. The second one sees
    // this PTY as belonging to a prior page load and kills it as orphaned.
    didFinishLoad?.()
    didFinishLoad?.()

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      proc.kill.mock.invocationCallOrder[0]
    )
  })

  it('clears PTY state even when kill reports the process is already gone', async () => {
    const proc = {
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        throw new Error('already dead')
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(proc)

    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    await handlers.get('pty:kill')!(null, { id: spawnResult.id })

    expect(await handlers.get('pty:hasChildProcesses')!(null, { id: spawnResult.id })).toBe(false)
    expect(openCodeClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
    expect(piClearPtyMock).toHaveBeenCalledWith(spawnResult.id)
  })
})
