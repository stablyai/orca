import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSshCredentialDeclinedForEnvironment,
  isSshCredentialDeclined,
  recordSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from './ssh-credential-decline'

const link = {
  requestId: 'request-1',
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  localPort: 41000,
  remotePort: 6768
}

describe('clearSshCredentialDeclinedForEnvironment', () => {
  beforeEach(() => {
    resetSshCredentialDeclinesForTests()
    recordSshCredentialDeclined('ssh-1')
  })

  it('lifts the decline for the SSH host a managed server is reached through', () => {
    clearSshCredentialDeclinedForEnvironment({ orcadDeployment: link })
    expect(isSshCredentialDeclined('ssh-1')).toBe(false)
  })

  it('lifts the decline for a server with independent SSH access', () => {
    clearSshCredentialDeclinedForEnvironment({
      sshAccess: { ...link, endpointId: 'ssh', previousPreferredEndpointId: 'direct' }
    })
    expect(isSshCredentialDeclined('ssh-1')).toBe(false)
  })

  it('leaves other hosts alone for a server not reached over SSH', () => {
    clearSshCredentialDeclinedForEnvironment({})
    expect(isSshCredentialDeclined('ssh-1')).toBe(true)
  })
})
