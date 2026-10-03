import { describe, expect, it } from 'vitest'

import { assessOrcadRollback, planOrcadUpdate } from './orcad-update-plan'
import {
  emptyOrcadActivationRecord,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from './orcad-activation-record'

const PROTOCOL = { protocolVersion: 3, previousProtocolVersions: [1, 2] }

const SNAPSHOT: OrcadStateSnapshot = {
  dirName: 'pre-0.2.0+bb01-1000',
  takenBeforeVersion: '0.2.0+bb01',
  readableByVersion: '0.1.0+aa01',
  takenAt: '2026-01-01T00:00:00.000Z'
}

function record(overrides: Partial<OrcadActivationRecord> = {}): OrcadActivationRecord {
  return {
    ...emptyOrcadActivationRecord(),
    active: '0.2.0+bb01',
    previous: '0.1.0+aa01',
    activatedAt: '2026-01-01T00:00:01.000Z',
    snapshot: SNAPSHOT,
    ...overrides
  }
}

describe('planOrcadUpdate', () => {
  it('does nothing when the candidate is already active', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.2.0+bb01',
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
    })
    expect(plan).toMatchObject({ action: 'noop' })
  })

  it('defers rather than restarting a host with live terminals', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 3, startedSinceActivation: 1, daemonProtocolVersion: 3 }
    })
    expect(plan).toMatchObject({ action: 'defer', code: 'orcad_update_terminals_running' })
    expect(plan.action === 'defer' && plan.reason).toContain('would not kill them')
  })

  it('defers when the session count cannot be established', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: 3 }
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_terminal_census_unavailable'
    })
  })

  it('plans a forced update with an unknown census as if terminals were live', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: 3 },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: true })
  })

  it('carries the daemon across a forced update with live terminals', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 2, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: true })
  })

  it('replaces the daemon only when nothing is running under it', () => {
    const plan = planOrcadUpdate({
      candidateDaemonProtocol: PROTOCOL,
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
  })
})

describe('assessOrcadRollback', () => {
  it('is clean when the snapshot is intact and nothing happened since activation', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'clean', target: '0.1.0+aa01' })
  })

  it('is lossy, and names what goes, once the store has been written since activation', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 1, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: true
    })
    expect(safety).toMatchObject({ safety: 'lossy', target: '0.1.0+aa01' })
    expect(safety.safety === 'lossy' && safety.discards[0]).toContain('2026-01-01T00:00:01.000Z')
  })

  it('treats an unreadable store mtime as writes, not as a clean rollback', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: null
    })
    expect(safety).toMatchObject({ safety: 'lossy' })
  })

  // The point past which rollback is unsafe: the first terminal created after activation.
  it('refuses once a terminal started after activation, because restoring would orphan it', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 4, startedSinceActivation: 1, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: true
    })
    expect(safety).toMatchObject({
      safety: 'unsafe',
      code: 'orcad_rollback_orphans_live_terminals'
    })
    expect(safety.safety === 'unsafe' && safety.reason).toContain('nothing would be able to')
  })

  it('refuses when the snapshot the record names is gone from the host', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: false,
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_snapshot_missing' })
    expect(safety.safety === 'unsafe' && safety.reason).toContain('no schema version')
  })

  it('refuses when no snapshot was ever recorded', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record({ snapshot: null }),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_snapshot_missing' })
  })

  it('refuses when the post-activation session count is unverifiable', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 2, startedSinceActivation: null, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_census_unavailable' })
  })

  it('refuses when there is no previous version to go back to', () => {
    const safety = assessOrcadRollback({
      targetDaemonProtocol: PROTOCOL,
      record: record({ previous: null }),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_no_target' })
  })
})

describe('D7 daemon protocol crossing', () => {
  const census = (daemonProtocolVersion: number | null, liveSessions: number | null = 2) => ({
    liveSessions,
    startedSinceActivation: 0,
    daemonProtocolVersion
  })

  it.each([false, true])(
    'defers an update that would strand live terminals (force %s)',
    (force) => {
      const plan = planOrcadUpdate({
        record: record(),
        candidateVersion: '0.3.0+cc01',
        candidateDaemonProtocol: PROTOCOL,
        census: census(4),
        force
      })
      expect(plan).toMatchObject({ action: 'defer', code: 'orcad_update_strands_live_terminals' })
    }
  )

  it('will not force past live terminals whose daemon protocol is unknown', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      candidateDaemonProtocol: PROTOCOL,
      census: census(null),
      force: true
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_daemon_protocol_unverifiable'
    })
  })

  it('needs no protocol answer when no terminals are running', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      candidateDaemonProtocol: PROTOCOL,
      census: census(null, 0)
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
  })

  it.each([
    [4, 'orcad_rollback_strands_live_terminals'],
    [null, 'orcad_rollback_daemon_protocol_unverifiable']
  ])('refuses a rollback when the daemon speaks %s', (daemonProtocolVersion, code) => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: census(daemonProtocolVersion),
      targetDaemonProtocol: PROTOCOL,
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code })
  })

  it('does not read an unverifiable snapshot probe as a missing snapshot', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: null,
      census: census(3, 0),
      targetDaemonProtocol: PROTOCOL,
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_snapshot_unverifiable' })
  })
})
