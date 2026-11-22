import { describe, expect, it } from 'vitest'
import { emptyOrcadActivationRecord } from '../activation/orcad-activation-record'
import { planOrcadUpdate } from '../activation/orcad-update-plan'
import { managedUpdateForce } from './orcad-managed-update-decision'

describe('managedUpdateForce', () => {
  it('gives full force, which can end uncounted terminals, only to a caller that confirmed it', () => {
    expect(managedUpdateForce({ force: true })).toBe('live-terminals')
    expect(managedUpdateForce({ force: true, endServerTerminals: true })).toBe(true)
    expect(managedUpdateForce({ endServerTerminals: true })).toBeUndefined()
    const incumbentVersion = '0.2.0'
    expect(managedUpdateForce({ pastLiveTerminals: { incumbentVersion } })).toBe('live-terminals')
    expect(managedUpdateForce({ pastLiveTerminals: { incumbentVersion, uncounted: true } })).toBe(
      true
    )
  })

  it('defers an uncounted server restart until the caller confirms terminals may end', () => {
    const input: Parameters<typeof planOrcadUpdate>[0] = {
      record: { ...emptyOrcadActivationRecord(), active: '0.2.0' },
      candidateVersion: '0.3.0',
      census: {
        answered: true,
        liveSessions: null,
        startedSinceActivation: null,
        daemonProtocolVersion: null
      },
      candidateDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [] },
      hostDaemonProtocols: []
    }
    expect(planOrcadUpdate({ ...input, force: managedUpdateForce({ force: true }) })).toMatchObject(
      {
        action: 'defer',
        forceable: true
      }
    )
    const confirmed = managedUpdateForce({ force: true, endServerTerminals: true })
    expect(planOrcadUpdate({ ...input, force: confirmed })).toMatchObject({
      action: 'proceed',
      preservesLiveDaemon: false
    })
  })
})
