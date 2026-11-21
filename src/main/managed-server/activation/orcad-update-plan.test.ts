import { describe, expect, it } from 'vitest'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import { planOrcadUpdate } from './orcad-update-plan'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'

const plan = (force: boolean, hostDaemonProtocols?: readonly number[]) =>
  planOrcadUpdate({
    record: { ...emptyOrcadActivationRecord(), active: '0.1.0+e2c8eab1a4b9' },
    candidateVersion: '0.1.0+8cc9da34df17',
    census: UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
    candidateDaemonProtocol: { protocolVersion: 61, previousProtocolVersions: [60] },
    ...(hostDaemonProtocols ? { hostDaemonProtocols } : {}),
    force
  })

describe('planOrcadUpdate with a daemon that cannot answer the census', () => {
  it('lets a forced update past a daemon the candidate proved is not running', () => {
    expect(plan(true, [])).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
    // Unforced, terminals orcad runs itself may still be live.
    expect(plan(false, [])).toMatchObject({
      action: 'defer',
      code: 'orcad_update_terminal_census_unavailable'
    })
    // A daemon that may still be running keeps the forced update deferred.
    expect(plan(true)).toMatchObject({
      action: 'defer',
      code: 'orcad_update_daemon_protocol_unverifiable'
    })
    expect(plan(true, [52])).toMatchObject({
      action: 'defer',
      code: 'orcad_update_daemon_protocol_unverifiable'
    })
  })
})
