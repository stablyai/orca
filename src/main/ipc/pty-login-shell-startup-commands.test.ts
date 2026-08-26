import { describe, expect, it, vi } from 'vitest'
import {
  loginPreflightExecFileMock,
  spawnMock,
  openCodeBuildPtyEnvMock
} from './pty-ipc-mock-registry'
import { posixOnlyIt } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { userInfo } from 'node:os'
import { resetMacosLoginShellPreflightForTests } from '../providers/macos-tcc-login-shell'
import { registerPtyHandlers } from './pty'
import { join } from 'node:path'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, createMockProc, spawnAndGetCall } = setupPtyIpcSuite()

  posixOnlyIt('wraps macOS spawns in login(1) with SHELL restored by the trampoline', async () => {
    const originalShell = process.env.SHELL
    // Re-enable the TCC login wrapper the suite-level beforeEach disables.
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    process.env.SHELL = '/bin/zsh'
    loginPreflightExecFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, 'ORCA_LOGIN_PREFLIGHT_OK', '')
        return { stdin: { end: vi.fn() } }
      }
    )
    resetMacosLoginShellPreflightForTests()

    try {
      const [file, args, options] = await spawnAndGetCall({ cwd: '/tmp' })
      expect(file).toBe('/usr/bin/login')
      expect(args).toEqual([
        '-flpq',
        userInfo().username,
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-p',
        '-c',
        'export SHELL="$1"; shift; exec -l -- "$@"',
        'orca-tcc-login',
        '/bin/zsh',
        '/bin/zsh',
        '-l'
      ])
      // The spawn env keeps the real shell so identity/name logic is intact.
      expect(options.env.SHELL).toBe('/bin/zsh')
    } finally {
      resetMacosLoginShellPreflightForTests()
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })
  it('uses the POSIX shell wrapper so OpenCode config survives shell startup files', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'

    try {
      const [shell, args, options] = await spawnAndGetCall({ cwd: '/tmp' })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(options.env.ORCA_OPENCODE_CONFIG_DIR).toBe('/tmp/orca-opencode-config')
      expect(options.env.ZDOTDIR).toBe(join(getShellReadyWrapperRoot(), 'zsh'))
      expect(options.env.ORCA_SHELL_FEATURES).not.toContain('ready')
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
  it('uses the POSIX shell wrapper so Pi config survives shell startup files', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/zsh'
    openCodeBuildPtyEnvMock.mockImplementationOnce(() => ({
      ORCA_OPENCODE_HOOK_PORT: '4567',
      ORCA_OPENCODE_HOOK_TOKEN: 'opencode-token',
      ORCA_OPENCODE_PTY_ID: 'test-pty'
    }))

    try {
      const [shell, args, options] = await spawnAndGetCall({
        cwd: '/tmp',
        env: { PI_CODING_AGENT_DIR: '/tmp/user-pi-agent' }
      })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(options.env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(options.env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(options.env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(options.env.ZDOTDIR).toBe(join(getShellReadyWrapperRoot(), 'zsh'))
      expect(options.env.ORCA_SHELL_FEATURES).not.toContain('ready')
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
  it('does not force ~/.bashrc after sourcing bash login files in the shell-ready rcfile', async () => {
    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.SHELL = '/bin/bash'

    try {
      await spawnAndGetCall({ cwd: '/tmp', command: 'echo hello' })

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
  posixOnlyIt(
    'does not write the startup command before the shell-ready marker arrives',
    async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
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
    }
  )
  posixOnlyIt(
    'uses the no-marker wrapper and writes quickly for Codex startup commands',
    async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: 'codex'
        })

        const [, , options] = spawnMock.mock.calls[0]!
        expect(options.env.ORCA_SHELL_FEATURES).not.toContain('ready')

        await Promise.resolve()
        vi.advanceTimersByTime(49)
        await Promise.resolve()
        expect(mockProc.proc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        vi.runAllTimers()
        expect(mockProc.proc.write).toHaveBeenCalledWith('codex\n')
      } finally {
        vi.useRealTimers()
      }
    }
  )
  posixOnlyIt('waits for shell-ready before writing delivery-hinted Codex startup', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready'
      })

      const [, , options] = spawnMock.mock.calls[0]!
      expect(options.env.ORCA_SHELL_FEATURES).toContain('ready')
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('last login: today\r\n')
      vi.advanceTimersByTime(1499)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]777;orca-shell-ready\x07')
      await Promise.resolve()
      vi.advanceTimersByTime(50)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(150)
      await Promise.resolve()
      expect(mockProc.proc.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
    } finally {
      vi.useRealTimers()
    }
  })
  posixOnlyIt(
    'uses the short settle path for delivery-hinted Codex when prompt follows the marker',
    async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        })

        mockProc.emitData('\x1b]777;orca-shell-ready\x07\r\nuser@host % ')
        await Promise.resolve()
        vi.advanceTimersByTime(29)
        await Promise.resolve()
        expect(mockProc.proc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        expect(mockProc.proc.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
      } finally {
        vi.useRealTimers()
      }
    }
  )
  posixOnlyIt('waits for shell-ready when Codex uses the native prefill flag', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: "codex --prefill 'linked issue context'"
      })

      const [, , options] = spawnMock.mock.calls[0]!
      expect(options.env.ORCA_SHELL_FEATURES).toContain('ready')
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      mockProc.emitData('\x1b]777;orca-shell-ready\x07')
      await Promise.resolve()
      vi.runAllTimers()
      await Promise.resolve()
      expect(mockProc.proc.write).toHaveBeenCalledWith("codex --prefill 'linked issue context'\n")
    } finally {
      vi.useRealTimers()
    }
  })
  posixOnlyIt('keeps the conservative max wait for non-agent startup commands', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        command: 'printf "hello"'
      })

      vi.advanceTimersByTime(1499)
      await Promise.resolve()
      expect(mockProc.proc.write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await Promise.resolve()
      vi.runAllTimers()
      expect(mockProc.proc.write).toHaveBeenCalledWith('printf "hello"\n')
    } finally {
      vi.useRealTimers()
    }
  })
})
