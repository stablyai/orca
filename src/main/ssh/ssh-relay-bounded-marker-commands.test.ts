import { describe, expect, it } from 'vitest'
import {
  SSH_RELAY_MARKER_MAX_BYTES,
  posixReadRelayMarkerAssignment,
  powerShellReadRelayMarkerAssignment
} from './ssh-relay-bounded-marker-commands'

describe('bounded SSH relay marker commands', () => {
  it('reads at most one byte past the Windows marker ceiling', () => {
    const script = powerShellReadRelayMarkerAssignment('C:/Users/me/.orca-remote/.gc-owner')

    expect(script).toContain('[System.IO.File]::Open')
    expect(script).toContain(`New-Object byte[] ${SSH_RELAY_MARKER_MAX_BYTES + 1}`)
    expect(script).toContain(`-le ${SSH_RELAY_MARKER_MAX_BYTES}`)
    expect(script).not.toContain('Get-Content')
    expect(script).not.toContain('ReadAllText')
  })

  it('caps POSIX command substitution before comparing an owner token', () => {
    const script = posixReadRelayMarkerAssignment('/home/u/.orca-remote/.gc-owner')

    expect(script).toContain(`bs=${SSH_RELAY_MARKER_MAX_BYTES + 1}`)
    expect(script).toContain(`-gt ${SSH_RELAY_MARKER_MAX_BYTES}`)
    expect(script).not.toContain('cat ')
  })
})
