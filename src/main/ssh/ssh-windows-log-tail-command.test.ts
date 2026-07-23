import { describe, expect, it } from 'vitest'
import {
  windowsRelayTailLogCommand,
  WINDOWS_RELAY_LOG_TAIL_MAX_BYTES
} from './ssh-windows-log-tail-command'

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

describe('Windows relay log tail command', () => {
  it('reads a fixed byte tail without line materialization', () => {
    const script = decodePowerShellCommand(
      windowsRelayTailLogCommand('C:/Users/u/relay.log', 'C:/Users/u/relay.err.log')
    )

    expect(script).toContain(
      `[Math]::Min([long]${WINDOWS_RELAY_LOG_TAIL_MAX_BYTES}, $stream.Length)`
    )
    expect(script).toContain('$stream.Seek(-[long]$readLength')
    expect(script).toContain('$stream.Read($buffer, $offset, $readLength - $offset)')
    expect(script).toContain('[System.IO.FileShare]::ReadWrite')
    expect(script).toContain('--- stderr ---')
    expect(script).not.toContain('Get-Content')
    expect(script).not.toContain('-Tail 20')
  })
})
