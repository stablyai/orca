import { describe, expect, it } from 'vitest'
import {
  getWindowsPowerShellExecutablePath,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

// AV compatibility requires omitting WindowStyle Hidden with EncodedCommand; unit tests cannot prove console behavior.
describe('windows PowerShell hook launcher', () => {
  it('keeps only the permitted switches outside the encoded payload', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(command).toMatch(/ -EncodedCommand [A-Za-z0-9+/=]+$/)
    expect(command.replace(/ -EncodedCommand \S+$/, '')).toBe(
      `${getWindowsPowerShellExecutablePath()} -NoProfile`
    )
  })
})
