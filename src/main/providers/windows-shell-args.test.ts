import { describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from '../powershell-osc133-bootstrap'
import {
  buildWslInteractiveLoginShellCommand,
  escapeWslShCommandForWindows
} from '../../shared/wsl-login-shell-command'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

function expectedWslArgs(linuxCwd: string, distro?: string): string[] {
  const command = `cd '${linuxCwd}' && export PATH="$HOME/.local/bin:$PATH" && ${buildWslInteractiveLoginShellCommand()}`
  const shellArgs = ['--', 'sh', '-c', escapeWslShCommandForWindows(command)]
  return distro ? ['-d', distro, ...shellArgs] : shellArgs
}

describe('resolveWindowsShellLaunchArgs', () => {
  it('returns cmd.exe args with chcp 65001 for UTF-8 output', () => {
    const result = resolveWindowsShellLaunchArgs('cmd.exe', 'C:\\Users\\alice', 'C:\\Users\\alice')
    expect(result.shellArgs).toEqual(['/K', 'chcp 65001 > nul'])
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
      'codex --no-alt-screen'
    )
    expect(result.shellArgs).toEqual(['/K', 'chcp 65001 > nul & codex --no-alt-screen'])
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('keeps large cmd.exe startup commands on stdin delivery', () => {
    const result = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      `codex ${'x'.repeat(7000)}`
    )
    expect(result.shellArgs).toEqual(['/K', 'chcp 65001 > nul'])
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
  })

  it('returns PowerShell args that install OSC 133 bootstrap after normal profile loading', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice'
    )
    expect(result.shellArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(getPowerShellOsc133Bootstrap())
    ])

    const command = Buffer.from(result.shellArgs[3] ?? '', 'base64').toString('utf16le')
    const outputEncodingIndex = command.indexOf('[Console]::OutputEncoding')
    const opencodeRestoreIndex = command.indexOf(
      '$env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR'
    )
    const ompWrapperIndex = command.indexOf('function Global:omp')
    const ompExtensionIndex = command.indexOf('--extension $env:ORCA_OMP_STATUS_EXTENSION')
    const codexRestoreIndex = command.indexOf('$env:CODEX_HOME = $env:ORCA_CODEX_HOME')
    const promptIndex = command.indexOf('function Global:prompt')

    expect(command).not.toContain('$PROFILE')
    expect(command).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(command).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(command).not.toContain('$env:PI_CODING_AGENT_DIR = $env:ORCA_OMP_SOURCE_AGENT_DIR')
    expect(outputEncodingIndex).toBeGreaterThanOrEqual(0)
    expect(opencodeRestoreIndex).toBeGreaterThan(outputEncodingIndex)
    expect(ompWrapperIndex).toBeGreaterThan(opencodeRestoreIndex)
    expect(ompExtensionIndex).toBeGreaterThan(ompWrapperIndex)
    expect(codexRestoreIndex).toBeGreaterThan(outputEncodingIndex)
    expect(codexRestoreIndex).toBeGreaterThan(ompWrapperIndex)
    expect(promptIndex).toBeGreaterThan(codexRestoreIndex)
    expect(command).toContain('Esc = [char]27')
    expect(command).toContain('Bel = [char]7')
    expect(command).toContain(')]133;D;$fakeExitCode$(')
    expect(command).toContain(')]133;C$(')
    expect(command).not.toContain('`e]133')
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

    const command = Buffer.from(result.shellArgs[3] ?? '', 'base64').toString('utf16le')
    expect(command).toContain('function Global:prompt')
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
    const command = Buffer.from(result.shellArgs[3] ?? '', 'base64').toString('utf16le')
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
    expect(result.shellArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(getPowerShellOsc133Bootstrap())
    ])
  })

  it('handles pwsh.exe (PowerShell Core) the same as Windows PowerShell', () => {
    const result = resolveWindowsShellLaunchArgs('pwsh.exe', 'C:\\', 'C:\\Users\\alice')
    expect(result.shellArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(getPowerShellOsc133Bootstrap())
    ])
  })

  it('starts Git Bash as an interactive login shell without changing cwd', () => {
    const result = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice'
    )

    expect(result.shellArgs).toEqual(['--login', '-i'])
    expect(result.effectiveCwd).toBe('C:\\Users\\alice\\code')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\code')
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
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice',
      undefined,
      'codex'
    )
    expect(result.shellArgs).toEqual(expectedWslArgs('/mnt/c/Users/alice/code'))
    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
    // Why: WSL cannot cd into a Windows path, so node-pty must start from the
    // user's Windows home and we inject the Linux cd into the shellArgs above.
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\code')
  })

  it('escapes single quotes when translating a WSL cwd', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', "C:\\weird'path", 'C:\\Users\\alice')
    // The injected sh cmd must not break out of the surrounding single quotes
    // when the path contains a ' character.
    expect(result.shellArgs[3]).toContain("cd '/mnt/c/weird'\\''path'")
    expect(result.shellArgs[3]).toContain('exec "\\$_orca_wsl_shell" -l')
  })

  it('falls back to /mnt/c when cwd is not a drive-letter path', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', '\\\\server\\share', 'C:\\Users\\alice')
    expect(result.shellArgs[3]).toContain(
      'cd \'/mnt/c\' && export PATH="\\$HOME/.local/bin:\\$PATH"'
    )
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
    expect(result.shellArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(getPowerShellOsc133Bootstrap())
    ])
  })
})
