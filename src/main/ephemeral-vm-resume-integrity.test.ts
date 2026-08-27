import { describe, expect, it } from 'vitest'
import type {
  EphemeralVmRecipeConnection,
  EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'
import { getProvisionedRootResumeIntegrityError } from './ephemeral-vm-resume-integrity'

type RecipeSshTarget = Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>['target']

describe('getProvisionedRootResumeIntegrityError', () => {
  it('allows an SSH endpoint to rotate while preserving its ownership identity', () => {
    const previous = provisionedSshResult()
    const resumed = provisionedSshResult({ host: 'new-host', port: 2222, label: 'Resumed VM' })

    expect(getProvisionedRootResumeIntegrityError(previous, resumed)).toBeNull()
  })

  it.each([
    ['config host', { configHost: 'other-alias' }],
    ['username', { username: 'other-user' }],
    ['identity file', { identityFile: '/keys/other' }],
    ['identity agent', { identityAgent: '/agents/other' }],
    ['identities-only setting', { identitiesOnly: true }],
    ['proxy command', { proxyCommand: 'ssh proxy' }],
    ['jump host', { jumpHost: 'bastion' }]
  ])('rejects changed SSH %s ownership', (_label, target) => {
    expect(
      getProvisionedRootResumeIntegrityError(provisionedSshResult(), provisionedSshResult(target))
    ).toContain('SSH ownership changed')
  })

  it('rejects a resume that changes the connection type', () => {
    const resumed: EphemeralVmRecipeResult = {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'orca-server',
        pairingCode: 'pairing-code',
        projectRoot: '/workspace/orca'
      }
    }

    expect(getProvisionedRootResumeIntegrityError(provisionedSshResult(), resumed)).toContain(
      'connection type changed'
    )
  })
})

function provisionedSshResult(target: Partial<RecipeSshTarget> = {}): EphemeralVmRecipeResult {
  return {
    schemaVersion: 2,
    checkoutMode: 'provisioned-root',
    connection: {
      type: 'ssh',
      projectRoot: '/workspace/orca',
      target: {
        label: 'VM',
        host: 'host',
        port: 22,
        username: 'orca',
        identityFile: '/keys/orca',
        identityAgent: '/agents/orca',
        ...target
      }
    }
  }
}
