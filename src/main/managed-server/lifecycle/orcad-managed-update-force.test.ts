import { describe, expect, it } from 'vitest'
import type { OrcadTerminalCensus } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import { emptyOrcadActivationRecord } from '../activation/orcad-activation-record'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../activation/orcad-daemon-protocol-crossing'
import { planOrcadUpdate } from '../activation/orcad-update-plan'
import { managedOrcadUpdateForce } from './orcad-managed-update-decision'

// What a released orcad answers when its daemon never started: no session or in-process count.
const OLDER_SERVER_UNCOUNTED: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null,
  answered: true
}

function planWith(force: ReturnType<typeof managedOrcadUpdateForce>) {
  return planOrcadUpdate({
    record: { ...emptyOrcadActivationRecord(), active: 'v1' },
    candidateVersion: 'v2',
    census: OLDER_SERVER_UNCOUNTED,
    candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
    // The candidate proved no daemon alive: the only terminals left run inside orcad.
    hostDaemonProtocols: [],
    force
  })
}

describe('managedOrcadUpdateForce', () => {
  it('keeps a bare force (CLI --force) deferring over an uncounted census', () => {
    const force = managedOrcadUpdateForce({ force: true })
    expect(force).toBe('live-terminals')
    expect(planWith(force)).toMatchObject({ action: 'defer', forceable: true })
  })

  it('lets a confirmed force (CLI --force --yes) pass once no daemon is alive', () => {
    const force = managedOrcadUpdateForce({ force: true, endInProcessTerminals: true })
    expect(force).toBe(true)
    expect(planWith(force)).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
  })

  it('ignores the confirmation without force', () => {
    expect(managedOrcadUpdateForce({ force: false, endInProcessTerminals: true })).toBe(false)
    expect(managedOrcadUpdateForce({ endInProcessTerminals: true })).toBeUndefined()
  })

  it('keeps the desktop Update anyway levels', () => {
    expect(
      managedOrcadUpdateForce({
        force: true,
        pastLiveTerminals: { incumbentVersion: 'v1', uncounted: true }
      })
    ).toBe(true)
    expect(managedOrcadUpdateForce({ pastLiveTerminals: { incumbentVersion: 'v1' } })).toBe(
      'live-terminals'
    )
  })
})
