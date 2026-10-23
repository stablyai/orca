import { describe, expect, it } from 'vitest'
import {
  encodeWindowsPowerShellHookCommand,
  getWindowsPowerShellExecutablePath,
  WINDOWS_POWERSHELL_HOOK_SWITCHES,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  expect(encoded).toBeTruthy()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

// AV compatibility requires omitting WindowStyle Hidden with EncodedCommand; unit tests cannot prove console behavior.
describe('windows PowerShell hook launcher', () => {
  it('never spells a denied flag on the command line', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).toBe('-NoProfile')
    expect(switches).toBe(`${getWindowsPowerShellExecutablePath()} -NoProfile`)
  })

  it('pins the exact launcher shape so a flag cannot come back unnoticed', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(command).toMatch(/ -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/)
  })

  it('keeps the execution-policy bypass, in the payload where AV cannot read it', () => {
    // Process-scope bypass permits .ps1 hooks under Restricted or AllSigned machine policy.
    expect(decodePayload(wrapWindowsPowerShellEncodedCommand('exit 0'))).toContain(
      'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue'
    )
  })

  it('can set the same process policy without loading the cmdlet', () => {
    const command = '& $scriptPath'
    const options = { useProcessPolicyEnvironment: true }
    expect(decodePayload(wrapWindowsPowerShellEncodedCommand(command, options))).toBe(
      "$ProgressPreference='SilentlyContinue'; $env:PSExecutionPolicyPreference='Bypass'; & $scriptPath"
    )
    expect(
      Buffer.from(encodeWindowsPowerShellHookCommand(command, options), 'base64').toString(
        'utf16le'
      )
    ).toBe(
      "$ProgressPreference='SilentlyContinue'; $env:PSExecutionPolicyPreference='Bypass'; & $scriptPath"
    )
  })

  it('swallows a terminating execution-policy failure, not just a non-terminating one', () => {
    // Swallow terminating GPO failures too; error records could corrupt merged JSON output.
    const decoded = decodePayload(wrapWindowsPowerShellEncodedCommand('exit 0'))

    expect(decoded).toMatch(/try \{[^}]*Set-ExecutionPolicy[^}]*\} catch \{\}/)
  })

  it('applies the bypass before the caller command and keeps progress silenced', () => {
    const decoded = Buffer.from(
      encodeWindowsPowerShellHookCommand('& $scriptPath'),
      'base64'
    ).toString('utf16le')

    expect(decoded).toBe(
      "$ProgressPreference='SilentlyContinue'; try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}; & $scriptPath"
    )
  })

  it('silences progress before anything that can autoload a module', () => {
    // Suppress progress before policy cmdlet autoload can emit CLIXML into merged JSON.
    const decoded = Buffer.from(
      encodeWindowsPowerShellHookCommand('& $scriptPath'),
      'base64'
    ).toString('utf16le')

    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeGreaterThanOrEqual(0)
    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      decoded.indexOf('Set-ExecutionPolicy')
    )
  })
})
