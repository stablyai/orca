import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { relayEndpointCredentialWriteCommand } from './ssh-relay-endpoint-credential'
import { getRemoteHostPlatform } from './ssh-remote-platform'

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded) {
    throw new Error(`Expected an encoded PowerShell command: ${command}`)
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('relay endpoint credential writes', () => {
  it('publishes a POSIX credential only from a restrictive temporary file', () => {
    const command = relayEndpointCredentialWriteCommand(
      getRemoteHostPlatform('linux-x64'),
      '/opt/orca node/bin/node',
      '/home/me user/.orca-remote/relay.sock.credential'
    )

    expect(command).toContain('{flag:"wx",mode:0o600}')
    expect(command).toContain('fs.writeFileSync(t,')
    expect(command).not.toContain('fs.writeFileSync(p,')
    expect(command.indexOf('fs.writeFileSync(t,')).toBeLessThan(
      command.indexOf('fs.renameSync(t,p)')
    )
    expect(command).toContain("'/home/me user/.orca-remote/relay.sock.credential'")
  })

  it('creates a Windows credential with its owner-only ACL before publication', () => {
    const script = decodePowerShellCommand(
      relayEndpointCredentialWriteCommand(
        getRemoteHostPlatform('win32-x64'),
        'C:/Program Files/nodejs/node.exe',
        'C:/Users/me user/.orca-remote/relay.sock.credential'
      )
    )

    expect(script).toContain("$path = 'C:/Users/me user/.orca-remote/relay.sock.credential'")
    expect(script).toContain('$security.SetAccessRuleProtection($true,$false)')
    expect(script).toContain('[System.IO.FileStream]::new($tempPath')
    expect(script).toContain('[System.IO.FileOptions]::WriteThrough,$security)')
    expect(script.indexOf('[System.IO.FileStream]::new')).toBeLessThan(
      script.indexOf('[System.IO.File]::Move($tempPath,$path)')
    )
    expect(script).not.toContain('Set-Acl')
    expect(script).not.toContain('icacls')
  })
})
