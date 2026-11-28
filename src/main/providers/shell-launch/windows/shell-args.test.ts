import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveWindowsShellLaunchArgs } from './shell-args'

const POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS = 28_400
const POWERSHELL_STAGED_COMMAND_ARG_MAX_CHARS = 30_000

function decodePowerShellCommand(encodedCommand: string): string {
  return Buffer.from(encodedCommand, 'base64').toString('utf16le')
}

describe('resolveWindowsShellLaunchArgs PowerShell staging', () => {
  it('stages a startup command whose encoded form exceeds the launch budget', () => {
    const startupCommand = `orca ${'x'.repeat(22_000)}`
    expect(Buffer.from(startupCommand, 'utf16le').toString('base64').length).toBeGreaterThan(
      POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS
    )

    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      startupCommand
    )

    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    const staging = result.startupCommandStaging!
    expect(existsSync(staging.scriptPath)).toBe(true)
    expect(readFileSync(staging.scriptPath, 'utf8')).toBe(startupCommand)
    const encodedCommand = result.shellArgs[3]!
    expect(encodedCommand.length).toBeLessThanOrEqual(POWERSHELL_STAGED_COMMAND_ARG_MAX_CHARS)
    const decoded = decodePowerShellCommand(encodedCommand)
    expect(decoded).not.toContain(startupCommand)
    expect(decoded).toContain('Get-Content -LiteralPath $__orcaStartupPath -Raw -Encoding UTF8')

    staging.cleanup()
    expect(existsSync(staging.directoryPath)).toBe(false)
  })

  it('keeps a startup command inline when its encoded launch fits', () => {
    const result = resolveWindowsShellLaunchArgs(
      'powershell.exe',
      'C:\\Users\\alice',
      'C:\\Users\\alice',
      undefined,
      'orca --version'
    )

    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    expect(result.startupCommandStaging).toBeUndefined()
    expect(decodePowerShellCommand(result.shellArgs[3]!)).toContain('orca --version')
  })
})
