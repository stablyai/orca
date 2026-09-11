import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWslInteractiveLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { resolveSetupRunnerCommand } from '../../shared/setup-runner-command'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from './local-pty-shell-ready-wrapper-root'

const CODEX_LAUNCH_PREFLIGHT = 'C:\\Program Files\\Orca\\orca.exe'
const CMD_CODEX_LAUNCH_PREFLIGHT =
  'if defined ORCA_CODEX_LAUNCH_PREFLIGHT call %ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE%%ORCA_CODEX_LAUNCH_PREFLIGHT%%ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE% agent hooks prepare-codex > nul 2>&1'

function expectedWslArgs(linuxCwd: string, distro?: string): string[] {
  const command = `cd '${linuxCwd}' && export PATH="$HOME/.local/bin:$PATH" && ${buildWslInteractiveLoginShellCommand()}`
  // Why spelled out rather than calling buildWslExecArgs: deriving the
  // expectation from the helper under test would still pass if it regressed
  // to the `--` separator.
  const shellArgs = ['--exec', 'sh', '-c', command]
  return distro ? ['-d', distro, ...shellArgs] : shellArgs
}

function decodePowerShellCommand(result: ReturnType<typeof resolveWindowsShellLaunchArgs>): string {
  expect(result.shellArgs.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
  return Buffer.from(result.shellArgs[3] ?? '', 'base64').toString('utf16le')
}

function expectedPowerShellRestoreCwdCommand(cwdLiteral: string): string {
  return `try { Set-Location -LiteralPath ${cwdLiteral} -ErrorAction Stop } catch { Write-Warning "Failed to restore working directory: $_" }`
}

function getGitBashRcfilePath(command: string): string {
  const rcfilePath = command.match(/--rcfile '([^']+)'/)?.[1]
  if (!rcfilePath) {
    throw new Error(`Git Bash launch command has no rcfile: ${command}`)
  }
  return rcfilePath
}

describe('resolveWindowsShellLaunchArgs', () => {
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'windows-shell-args-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('returns cmd.exe args with chcp 65001 for UTF-8 output', () => {
    const result = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      undefined,
      CODEX_LAUNCH_PREFLIGHT
    )
    expect(result.shellArgs).toEqual(['/K', `chcp 65001 > nul & ${CMD_CODEX_LAUNCH_PREFLIGHT}`])
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice')
  })

  it('embeds short cmd.exe startup commands in shell args', () => {
    const result = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      'codex --no-alt-screen',
      CODEX_LAUNCH_PREFLIGHT
    )
    expect(result.shellArgs).toEqual([
      '/K',
      `chcp 65001 > nul & ${CMD_CODEX_LAUNCH_PREFLIGHT} & codex --no-alt-screen`
    ])
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('keeps quoted cmd.exe startup commands on stdin delivery', () => {
    // Why: direct queued cmd commands need normal quotes, which node-pty's
    // C-runtime argv escaping corrupts when delivered through `/K`.
    const result = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice\\repo',
      'C:\\Users\\alice',
      undefined,
      'cd /d "C:\\Users\\alice\\repo" && claude "--resume" "session one"'
    )
    expect(result.shellArgs).toEqual(['/K', 'chcp 65001 > nul'])
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('keeps large cmd.exe startup commands on stdin delivery', () => {
    const result = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      `codex ${'x'.repeat(7000)}`,
      CODEX_LAUNCH_PREFLIGHT
    )
    expect(result.shellArgs).toEqual(['/K', `chcp 65001 > nul & ${CMD_CODEX_LAUNCH_PREFLIGHT}`])
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('returns PowerShell args that install OSC 133 bootstrap after normal profile loading', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice'
    )
    expect(result.shellArgs).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)])

    const command = decodePowerShellCommand(result)
    const outputEncodingIndex = command.indexOf('[Console]::OutputEncoding')
    const opencodeRestoreIndex = command.indexOf(
      '$env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR'
    )
    const mimocodeRestoreIndex = command.indexOf('$env:MIMOCODE_HOME = $env:ORCA_MIMOCODE_HOME')
    const duplicateStateGuardIndex = command.indexOf('Test-Path variable:global:__OrcaOsc133State')
    const languageModeGuardIndex = command.indexOf('LanguageMode -eq "FullLanguage"')
    const ompWrapperIndex = command.indexOf('function Global:omp')
    const ompExtensionIndex = command.indexOf('--extension $env:ORCA_OMP_STATUS_EXTENSION')
    const codexRestoreIndex = command.indexOf('$env:CODEX_HOME = $env:ORCA_CODEX_HOME')
    const promptIndex = command.indexOf('function Global:prompt')
    const cwdRestoreIndex = command.indexOf(
      expectedPowerShellRestoreCwdCommand("'C:\\Users\\alice'")
    )

    expect(command).not.toContain('$PROFILE')
    expect(command).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(command).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(command).not.toContain('$env:PI_CODING_AGENT_DIR = $env:ORCA_OMP_SOURCE_AGENT_DIR')
    for (const restoreIndex of [opencodeRestoreIndex, mimocodeRestoreIndex, codexRestoreIndex]) {
      expect(restoreIndex).toBeGreaterThanOrEqual(0)
      expect(restoreIndex).toBeLessThan(duplicateStateGuardIndex)
      expect(restoreIndex).toBeLessThan(languageModeGuardIndex)
    }
    expect(outputEncodingIndex).toBeGreaterThan(languageModeGuardIndex)
    expect(outputEncodingIndex).toBeGreaterThan(duplicateStateGuardIndex)
    expect(ompWrapperIndex).toBeGreaterThan(outputEncodingIndex)
    expect(ompExtensionIndex).toBeGreaterThan(ompWrapperIndex)
    expect(promptIndex).toBeGreaterThan(ompWrapperIndex)
    expect(cwdRestoreIndex).toBeGreaterThan(promptIndex)
    expect(command).toContain('Esc = [char]27')
    expect(command).toContain('Bel = [char]7')
    expect(command).toContain(')]133;D;$fakeExitCode$(')
    expect(command).toContain(')]133;C$(')
    expect(command).not.toContain('`e]133')
  })

  it('normalizes MSYS drive cwd before spawning native PowerShell', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      '/c/Users/alice/project',
      'C:\\Users\\alice'
    )

    expect(result.effectiveCwd).toBe('C:\\Users\\alice\\project')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\project')
    expect(decodePowerShellCommand(result)).toContain(
      expectedPowerShellRestoreCwdCommand("'C:\\Users\\alice\\project'")
    )
  })

  it('quotes the PowerShell cwd restore command literally', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      "C:\\Users\\alice\\client's app",
      'C:\\Users\\alice'
    )

    expect(decodePowerShellCommand(result)).toContain(
      expectedPowerShellRestoreCwdCommand("'C:\\Users\\alice\\client''s app'")
    )
  })

  it('embeds short PowerShell startup commands after the OSC 133 bootstrap', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      "& 'codex' '--no-alt-screen'"
    )
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)

    const command = decodePowerShellCommand(result)
    expect(command).toContain('function Global:prompt')
    expect(command).toContain(expectedPowerShellRestoreCwdCommand("'C:\\Users\\alice'"))
    expect(command.trimEnd().endsWith("& 'codex' '--no-alt-screen'")).toBe(true)
  })

  it('preserves complex PowerShell startup command text through EncodedCommand', () => {
    const startupCommand =
      '& "C:\\Program Files\\Orca CLI\\orca.exe" "--label" "quoted value"; $env:ORCA_VALUE = "nested"'
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      startupCommand
    )

    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    const command = decodePowerShellCommand(result)
    expect(command).toContain(`\n${startupCommand}`)
    expect(command.trimEnd().endsWith(startupCommand)).toBe(true)
  })

  it('keeps large PowerShell startup commands on stdin delivery', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      `orca ${'x'.repeat(7000)}`
    )

    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
    expect(result.shellArgs).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)])
    expect(decodePowerShellCommand(result)).toContain(
      expectedPowerShellRestoreCwdCommand("'C:\\Users\\alice'")
    )
  })

  it('handles pwsh.exe (PowerShell Core) the same as Windows PowerShell', () => {
    const result = resolveWindowsShellLaunchArgs('pwsh.exe', 'C:\\', 'C:\\Users\\alice')
    expect(result.shellArgs).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)])
    expect(decodePowerShellCommand(result)).toContain(expectedPowerShellRestoreCwdCommand("'C:\\'"))
  })

  it('does not change PowerShell args when the cmd/Git Bash preflight is provided', () => {
    const baseline = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice'
    )
    const withWindowsPreflight = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      undefined,
      CODEX_LAUNCH_PREFLIGHT
    )

    expect(withWindowsPreflight).toEqual(baseline)
  })

  it('starts Git Bash as an interactive login shell with UTF-8 console setup', () => {
    const result = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '/c',
      'C:\\Users\\alice',
      undefined,
      undefined,
      CODEX_LAUNCH_PREFLIGHT
    )

    // Why: Git Bash inherits the ConPTY OEM code page (CP437), so a byte-writing
    // UTF-8 TUI mojibakes unless the console is switched to UTF-8 before it runs.
    // Assert the contract behaviorally: chcp.com 65001 must precede the exec'd
    // interactive login shell (which preserves `--login -i` and the shell's
    // foreground identity), rather than pinning the exact command string.
    expect(result.shellArgs[0]).toBe('-c')
    const bashCommand = result.shellArgs[1]
    expect(bashCommand).toContain('chcp.com 65001')
    expect(bashCommand).toContain('--rcfile')
    expect(bashCommand).toMatch(/exec "\$BASH" .* -i$/)
    // The UTF-8 switch must run before the login shell is exec'd.
    expect(bashCommand.indexOf('chcp.com')).toBeLessThan(bashCommand.indexOf('exec'))
    // Must stay fail-open: `;` (not `&&`) so a missing chcp.com can't abort the
    // exec and kill the terminal on startup.
    expect(bashCommand).not.toContain('&&')
    expect(result.effectiveCwd).toBe('C:\\')
    expect(result.validationCwd).toBe('C:\\')

    const bashRcfile = readFileSync(getGitBashRcfilePath(bashCommand), 'utf8')
    expect(bashRcfile).toContain('"${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex')
    expect(bashRcfile).not.toContain(CODEX_LAUNCH_PREFLIGHT)
  })

  it('keeps Git Bash startup commands on stdin delivery with the preflight wrapper', () => {
    const result = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      'codex --no-alt-screen',
      CODEX_LAUNCH_PREFLIGHT
    )

    expect(result.shellArgs[1]).toContain('chcp.com 65001')
    expect(result.shellArgs[1]).toContain('--rcfile')
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('quotes a spaced preflight path through each shell environment', () => {
    const cmd = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      undefined,
      CODEX_LAUNCH_PREFLIGHT
    )
    const gitBash = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      undefined,
      CODEX_LAUNCH_PREFLIGHT
    )

    expect(cmd.shellArgs[1]).toContain(
      'call %ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE%%ORCA_CODEX_LAUNCH_PREFLIGHT%%ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE%'
    )
    expect(cmd.shellArgs[1]).not.toContain('"')
    expect(cmd.shellArgs[1]).not.toContain(CODEX_LAUNCH_PREFLIGHT)
    const rcfilePath = getGitBashRcfilePath(gitBash.shellArgs[1])
    expect(readFileSync(rcfilePath, 'utf8')).toContain('"${ORCA_CODEX_LAUNCH_PREFLIGHT}"')
  })

  it('does not apply Git Bash launch args to unrelated bash.exe paths', () => {
    const result = resolveWindowsShellLaunchArgs(
      'C:\\msys64\\usr\\bin\\bash.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice'
    )

    expect(result.shellArgs).toEqual([])
    expect(result.effectiveCwd).toBe('C:\\Users\\alice\\code')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\code')
  })

  it('translates Windows cwd to /mnt/<drive>/... for wsl.exe', () => {
    const baseline = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice',
      undefined,
      'codex'
    )
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice',
      undefined,
      'codex',
      CODEX_LAUNCH_PREFLIGHT
    )
    expect(result).toEqual(baseline)
    expect(result.shellArgs).toEqual(expectedWslArgs('/mnt/c/Users/alice/code'))
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
    // Why: WSL cannot cd into a Windows path, so node-pty must start from the
    // user's Windows home and we inject the Linux cd into the shellArgs above.
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\code')
  })

  it('materializes shell-ready wrappers before building WSL shell args', () => {
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice'
    )

    expect(result.shellArgs).toEqual(expectedWslArgs('/mnt/c/Users/alice/code'))
    expect(existsSync(join(getShellReadyWrapperRoot(), 'bash', 'rcfile'))).toBe(true)
    expect(existsSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'))).toBe(true)

    // Why: typed OMP keeps its existing shell integration, while typed Prime
    // commands must reach the user's binary without Orca rewriting argv.
    const bashRcfile = readFileSync(join(getShellReadyWrapperRoot(), 'bash', 'rcfile'), 'utf8')
    // Why .zshenv: the omp wrapper is part of the epilogue defined there.
    const zshEnv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    for (const wrapperFile of [bashRcfile, zshEnv]) {
      expect(wrapperFile).toContain('command omp --extension "${ORCA_OMP_STATUS_EXTENSION}" "$@"')
      expect(wrapperFile).toContain('function omp { __orca_omp "$@"; }')
      expect(wrapperFile).not.toContain('prime-agent()')
      expect(wrapperFile).not.toContain('__orca_prime_agent')
      expect(wrapperFile).not.toContain('ORCA_PRIME_AGENT_STATUS_EXTENSION')
      expect(wrapperFile).not.toContain('command prime-agent --extension')
    }
  })

  it('translates MSYS drive cwd to /mnt/<drive>/... for wsl.exe', () => {
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      '/c/Users/alice/project',
      'C:\\Users\\alice',
      undefined,
      'codex'
    )

    expect(result.shellArgs).toEqual(expectedWslArgs('/mnt/c/Users/alice/project'))
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\project')
  })

  it.each(['/a', '/c'])('keeps a selected WSL runtime single-letter cwd exact (%s)', (cwd) => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', cwd, 'C:\\Users\\alice', {
      distro: 'Ubuntu',
      treatPosixCwdAsWsl: true
    })

    expect(result.shellArgs).toEqual(expectedWslArgs(cwd, 'Ubuntu'))
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe(`\\\\wsl.localhost\\Ubuntu\\${cwd.slice(1)}`)
  })

  it('escapes single quotes when translating a WSL cwd', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', "C:\\weird'path", 'C:\\Users\\alice')
    // The injected sh cmd must not break out of the surrounding single quotes
    // when the path contains a ' character.
    expect(result.shellArgs[3]).toContain("cd '/mnt/c/weird'\\''path'")
    expect(result.shellArgs[3]).toContain('exec "$_orca_wsl_shell" -l')
  })

  it('falls back to /mnt/c when cwd is not a drive-letter path', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', '\\\\server\\share', 'C:\\Users\\alice')
    expect(result.shellArgs[3]).toContain('cd \'/mnt/c\' && export PATH="$HOME/.local/bin:$PATH"')
  })

  it('keeps WSL UNC worktree cwd inside the matching distro', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const result = resolveWindowsShellLaunchArgs(
        'wsl.exe',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
        'C:\\Users\\alice'
      )
      expect(result.shellArgs).toEqual(expectedWslArgs('/home/alice/repo', 'Ubuntu'))
      expect(result.effectiveCwd).toBe('C:\\Users\\alice')
      expect(result.validationCwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('keeps POSIX cwd inside the worktree distro when WSL context is provided', () => {
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      '/home/alice/repo/subdir',
      'C:\\Users\\alice',
      { distro: 'Ubuntu', treatPosixCwdAsWsl: true }
    )

    expect(result.shellArgs).toEqual(expectedWslArgs('/home/alice/repo/subdir', 'Ubuntu'))
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\subdir')
  })

  it('falls back to empty args + same cwd for unknown shells', () => {
    const result = resolveWindowsShellLaunchArgs(
      'C:\\tools\\fish.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice'
    )
    expect(result.shellArgs).toEqual([])
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice')
  })

  it('is case-insensitive on the shell basename', () => {
    const result = resolveWindowsShellLaunchArgs('PowerShell.EXE', 'C:\\', 'C:\\')
    expect(result.shellArgs).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', expect.any(String)])
  })
})

// Regression guard for issue #7236: a worktree Setup Script runs through a
// generated `.cmd` runner invoked as `cmd.exe /c "<runner>"`. When PowerShell
// received that command as raw typed stdin, a dropped/unbalanced quote surfaced
// as a "missing terminator" parser error. Delivering it via -EncodedCommand
// (base64 UTF-16) keeps the quotes balanced and the text verbatim, so it can
// never be re-parsed as an open string.
describe('issue #7236: PowerShell setup-runner command delivery', () => {
  // git rev-parse hands back a forward-slash Windows-absolute path for the runner.
  const runnerPath = 'C:/Users/alice/repo/.git/orca/setup-runner.cmd'

  it('wraps the setup runner in balanced double quotes', () => {
    const { command } = resolveSetupRunnerCommand(runnerPath, 'windows')
    expect(command).toBe(`cmd.exe /c "${runnerPath}"`)
    expect((command.match(/"/g) ?? []).length % 2).toBe(0)
  })

  it('delivers the setup-runner command through -EncodedCommand, never raw stdin', () => {
    const { command } = resolveSetupRunnerCommand(runnerPath, 'windows')
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice\\repo',
      'C:\\Users\\alice',
      undefined,
      command
    )

    // The flag tells the daemon/provider NOT to also type the command over
    // stdin — raw stdin delivery is the pre-encoded path that broke in #7236.
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    expect(result.shellArgs.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])

    const decoded = Buffer.from(result.shellArgs[3] ?? '', 'base64').toString('utf16le')
    expect(decoded).toContain(`\n${command}`)
    expect(decoded.trimEnd().endsWith(command)).toBe(true)
    // Quotes survive encoding intact, so PowerShell parses one balanced string.
    expect((decoded.slice(decoded.lastIndexOf(command)).match(/"/g) ?? []).length % 2).toBe(0)
  })
})
