import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'
import { decodeRemotePowerShellScript, powerShellCommand } from './ssh-remote-powershell'

// Stock sshd's cmd.exe DefaultShell rejects oversized exec lines with localized diagnostics.
describe('Windows remote command line limit', () => {
  it('carries an oversized script through gzip without altering it', () => {
    const script = Array.from(
      { length: 200 },
      (_unused, index) => `Write-Output ${index}; $slot = 'C:\\Users\\orca\\stage-${index}'`
    ).join('\n')
    const command = powerShellCommand(script)
    expect(command.length).toBeLessThanOrEqual(CMD_EXE_COMMAND_LINE_MAX_CHARS)
    expect(decodeRemotePowerShellScript(command)).toBe(script)
    const bootstrap = Buffer.from(
      command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1] ?? '',
      'base64'
    ).toString('utf16le')
    const payload = bootstrap.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)?.[1] ?? ''
    expect(gunzipSync(Buffer.from(payload, 'base64')).toString('utf-8')).toBe(script)
    expect(bootstrap).toContain('Invoke-Expression $OrcaScriptText')
  })

  it('refuses a script no encoding can fit instead of letting cmd.exe reject it', () => {
    let seed = 12345
    const incompressible = Array.from({ length: 60_000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return String.fromCharCode(97 + (seed % 26))
    }).join('')
    expect(() => powerShellCommand(`Write-Output '${incompressible}'`)).toThrow(
      /Orca budgets 8000 for a line sshd hands to cmd\.exe/u
    )
  })
})
