import { describe, expect, it } from 'vitest'
import {
  encodeWindowsPowerShellHookCommand,
  getWindowsPowerShellExecutablePath,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error('Missing encoded PowerShell command')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

// AV compatibility requires omitting WindowStyle Hidden with EncodedCommand; unit tests cannot prove console behavior.
describe('windows PowerShell hook launcher', () => {
  it('keeps only the permitted switches outside the encoded payload', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(command).toMatch(/ -EncodedCommand [A-Za-z0-9+/=]+$/)
    expect(command.replace(/ -EncodedCommand \S+$/, '')).toBe(
      `${getWindowsPowerShellExecutablePath()} -NoProfile`
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

  it('silences progress before guarded policy setup and the caller command', () => {
    const command = '& $scriptPath'
    const payloads = [
      decodePayload(wrapWindowsPowerShellEncodedCommand(command)),
      Buffer.from(encodeWindowsPowerShellHookCommand(command), 'base64').toString('utf16le')
    ]

    for (const payload of payloads) {
      expect(payload).toBe(
        "$ProgressPreference='SilentlyContinue'; try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}; & $scriptPath"
      )
    }
  })
})
