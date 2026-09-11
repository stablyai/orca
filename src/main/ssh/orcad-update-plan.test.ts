import { describe, expect, it } from 'vitest'

import { assessOrcadRollback, planOrcadUpdate, type OrcadTerminalCensus } from './orcad-update-plan'
import {
  emptyOrcadActivationRecord,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from './orcad-activation-record'

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
      record: record(),
      candidateVersion: '0.2.0+bb01',
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 }
    })
    expect(plan).toMatchObject({ action: 'noop' })
  })

  it('defers rather than restarting a host with live terminals', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 3, startedSinceActivation: 1, liveStructuredSessions: 0 }
    })
    expect(plan).toMatchObject({ action: 'defer', code: 'orcad_update_terminals_running' })
    expect(plan.action === 'defer' && plan.reason).toContain('would not kill them')
  })

  it('defers when the session count cannot be established', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: null, startedSinceActivation: null, liveStructuredSessions: 0 }
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_terminal_census_unavailable'
    })
  })

  it('plans a forced update with an unknown census as if terminals were live', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: null, startedSinceActivation: null, liveStructuredSessions: 0 },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: true })
  })

  it('carries the daemon across a forced update with live terminals', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 2, startedSinceActivation: 0, liveStructuredSessions: 0 },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: true })
  })

  it('replaces the daemon only when nothing is running under it', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 }
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
  })

  // The restart ends structured providers outright; the daemon that saves terminals saves none
  // of them, so the census needs its own term and its own arm.
  it('defers rather than restarting a host with live structured agent sessions', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 1 }
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_structured_sessions_running'
    })
    expect(plan.action === 'defer' && plan.reason).toContain('would end them')
  })

  it('defers when the structured session count cannot be established', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: null }
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_structured_census_unavailable'
    })
  })

  // An incomplete census is unprobeable, not empty: a producer that never learned the term must
  // not be read as having answered zero.
  it('never reads a census missing the structured term as zero', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0 } as OrcadTerminalCensus
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_structured_census_unavailable'
    })
  })

  it('names the structured loss first when terminals are live too', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 3, startedSinceActivation: 1, liveStructuredSessions: 2 }
    })
    expect(plan).toMatchObject({
      action: 'defer',
      code: 'orcad_update_structured_sessions_running'
    })
  })

  it('says what a forced update costs the structured sessions it is about to end', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 2 },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: false })
    expect(plan.action === 'proceed' && plan.notes.join(' ')).toContain(
      '2 live structured agent sessions'
    )
  })

  it('says the same when a forced update cannot count the structured sessions', () => {
    const plan = planOrcadUpdate({
      record: record(),
      candidateVersion: '0.3.0+cc01',
      census: { liveSessions: null, startedSinceActivation: null, liveStructuredSessions: null },
      force: true
    })
    expect(plan).toMatchObject({ action: 'proceed', preservesLiveDaemon: true })
    expect(plan.action === 'proceed' && plan.notes.join(' ')).toContain(
      'unverifiable structured session count'
    )
  })
})

describe('assessOrcadRollback', () => {
  it('is clean when the snapshot is intact and nothing happened since activation', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'clean', target: '0.1.0+aa01' })
  })

  it('is lossy, and names what goes, once the store has been written since activation', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 1, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: true
    })
    expect(safety).toMatchObject({ safety: 'lossy', target: '0.1.0+aa01' })
    expect(safety.safety === 'lossy' && safety.discards[0]).toContain('2026-01-01T00:00:01.000Z')
  })

  it('treats an unreadable store mtime as writes, not as a clean rollback', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: null
    })
    expect(safety).toMatchObject({ safety: 'lossy' })
  })

  // The point past which rollback is unsafe: the first terminal created after activation.
  it('refuses once a terminal started after activation, because restoring would orphan it', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 4, startedSinceActivation: 1, liveStructuredSessions: 0 },
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
      record: record(),
      snapshotPresent: false,
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_snapshot_missing' })
    expect(safety.safety === 'unsafe' && safety.reason).toContain('no schema version')
  })

  it('refuses when no snapshot was ever recorded', () => {
    const safety = assessOrcadRollback({
      record: record({ snapshot: null }),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_snapshot_missing' })
  })

  it('refuses when the post-activation session count is unverifiable', () => {
    const safety = assessOrcadRollback({
      record: record(),
      snapshotPresent: true,
      census: { liveSessions: 2, startedSinceActivation: null, liveStructuredSessions: 0 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_census_unavailable' })
  })

  it('refuses when there is no previous version to go back to', () => {
    const safety = assessOrcadRollback({
      record: record({ previous: null }),
      snapshotPresent: true,
      census: { liveSessions: 0, startedSinceActivation: 0, liveStructuredSessions: 0 },
      stateWritesSinceActivation: false
    })
    expect(safety).toMatchObject({ safety: 'unsafe', code: 'orcad_rollback_no_target' })
  })
})
