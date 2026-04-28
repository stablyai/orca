import { describe, expect, it } from 'vitest'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

describe('resolveWindowsShellLaunchArgs', () => {
  it('returns cmd.exe args with chcp 65001 for UTF-8 output', () => {
    const result = resolveWindowsShellLaunchArgs('cmd.exe', 'C:\\Users\\alice', 'C:\\Users\\alice')
    expect(result.shellArgs).toEqual(['/K', 'chcp 65001 > nul'])
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice')
  })

  it('returns PowerShell args that dot-source $PROFILE and force UTF-8 I/O', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice'
    )
    expect(result.shellArgs[0]).toBe('-NoExit')
    expect(result.shellArgs[1]).toBe('-Command')
    // The actual command must dot-source $PROFILE before setting encodings,
    // otherwise oh-my-posh / starship / PSReadLine never load.
    expect(result.shellArgs[2]).toContain('. $PROFILE')
    expect(result.shellArgs[2]).toContain('UTF8')
  })

  it('handles pwsh.exe (PowerShell Core) the same as Windows PowerShell', () => {
    const result = resolveWindowsShellLaunchArgs('pwsh.exe', 'C:\\', 'C:\\Users\\alice')
    expect(result.shellArgs[0]).toBe('-NoExit')
  })

  it('translates Windows cwd to /mnt/<drive>/... for wsl.exe', () => {
    const result = resolveWindowsShellLaunchArgs(
      'wsl.exe',
      'C:\\Users\\alice\\code',
      'C:\\Users\\alice'
    )
    expect(result.shellArgs).toEqual([
      '--',
      'bash',
      '-c',
      "cd '/mnt/c/Users/alice/code' && exec bash -l"
    ])
    // Why: WSL cannot cd into a Windows path, so node-pty must start from the
    // user's Windows home and we inject the Linux cd into the shellArgs above.
    expect(result.effectiveCwd).toBe('C:\\Users\\alice')
    expect(result.validationCwd).toBe('C:\\Users\\alice\\code')
  })

  it('escapes single quotes when translating a WSL cwd', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', "C:\\weird'path", 'C:\\Users\\alice')
    // The injected bash cmd must not break out of the surrounding single
    // quotes when the path contains a ' character.
    expect(result.shellArgs[3]).toBe("cd '/mnt/c/weird'\\''path' && exec bash -l")
  })

  it('falls back to /mnt/c when cwd is not a drive-letter path', () => {
    const result = resolveWindowsShellLaunchArgs('wsl.exe', '\\\\server\\share', 'C:\\Users\\alice')
    expect(result.shellArgs[3]).toBe("cd '/mnt/c' && exec bash -l")
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
    expect(result.shellArgs[0]).toBe('-NoExit')
  })
})
