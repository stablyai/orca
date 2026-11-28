import { describe, expect, it } from 'vitest'
import { findNamesakeBeforeDeploy } from './orcad-deploy-namesake'

const OVER_SSH = {
  sshTargetId: 'ssh-lan',
  sshTargetGeneration: 1,
  localPort: 41000,
  remotePort: 6768
}
const saved = [
  { id: 'managed', name: 'dell', orcadDeployment: OVER_SSH },
  { id: 'paired', name: 'box' }
]

function namesake(name: string, moveSavedServer = true): string | undefined {
  return findNamesakeBeforeDeploy(saved, { name, environmentId: 'new', moveSavedServer })?.id
}

describe('findNamesakeBeforeDeploy', () => {
  it('leaves servers managed over SSH to the host-key check', () => {
    expect(namesake('dell')).toBeUndefined()
    expect(namesake('box')).toBe('paired')
    expect(namesake('dell', false)).toBe('managed')
  })
})
