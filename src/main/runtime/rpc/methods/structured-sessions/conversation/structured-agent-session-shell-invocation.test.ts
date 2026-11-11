import { describe, expect, it } from 'vitest'
import { shellCommandInvocation } from './structured-agent-session-shell-invocation'

describe('shellCommandInvocation', () => {
  it('records the final directory and keeps the exit status in POSIX shells', () => {
    expect(shellCommandInvocation('/bin/zsh', 'cd src', 'darwin')).toEqual({
      args: [
        '-c',
        'eval "$ORCA_SHELL_COMMAND"\n__orca_status=$?\npwd > "$ORCA_SHELL_CWD_FILE" 2>/dev/null\nexit $__orca_status'
      ],
      capturesCwd: true,
      env: { ORCA_SHELL_COMMAND: 'cd src' }
    })
  })

  it('uses fish syntax for fish', () => {
    expect(shellCommandInvocation('/opt/homebrew/bin/fish', 'cd src', 'darwin')).toEqual({
      args: [
        '-c',
        'eval "$ORCA_SHELL_COMMAND"\nset -l __orca_status $status\npwd > "$ORCA_SHELL_CWD_FILE" 2>/dev/null\nexit $__orca_status'
      ],
      capturesCwd: true,
      env: { ORCA_SHELL_COMMAND: 'cd src' }
    })
  })

  it('runs Windows shells without directory capture', () => {
    expect(shellCommandInvocation('C:\\Windows\\System32\\cmd.exe', 'dir', 'win32')).toEqual({
      args: ['/d', '/s', '/c', '"dir"'],
      windowsVerbatimArguments: true,
      capturesCwd: false
    })
    expect(shellCommandInvocation('pwsh.exe', 'Get-Location', 'win32')).toEqual({
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Location'],
      capturesCwd: false
    })
    expect(shellCommandInvocation('C:\\Program Files\\Git\\bin\\bash.exe', 'pwd', 'win32')).toEqual(
      {
        args: ['-c', 'pwd'],
        capturesCwd: false
      }
    )
  })
})
