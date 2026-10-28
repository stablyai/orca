import { describe, expect, it } from 'vitest'
import { wslMoveOrchestratorSchema } from '../../shared/telemetry-wsl-move-event-schemas'
import type { WslMoveOrchestratorRecord } from '../../shared/wsl-move/wsl-move-orchestrator-types'
import { wslMoveOrchestratorEventProps } from './wsl-move-orchestrator-telemetry'

function record(
  state: WslMoveOrchestratorRecord['state'],
  attempts = 0
): WslMoveOrchestratorRecord {
  return { distro: 'Secret-Distro', state, attempts, appVersion: '1.0.0', updatedAt: 0 }
}

describe('wslMoveOrchestratorEventProps', () => {
  it('reports enums only, valid against the strict schema', () => {
    const props = wslMoveOrchestratorEventProps(
      'project-opened',
      record({ kind: 'parked', reason: 'manifest-too-large' }, 3),
      { outcome: 'refused', code: 'wsl_move_manifest_too_large' }
    )
    expect(props).toEqual({
      trigger: 'project_opened',
      transition: 'parked',
      refusal: 'manifest_too_large',
      reset_reason: 'none',
      park_reason: 'manifest_too_large',
      attempt_bucket: '2_3'
    })
    expect(wslMoveOrchestratorSchema.parse(props)).toEqual(props)
    expect(JSON.stringify(props)).not.toContain('Secret')
  })

  it('names a reset by its code, never its detail', () => {
    const props = wslMoveOrchestratorEventProps(
      'timer',
      record({ kind: 'backoff', nextAttemptAt: 1, reason: 'x' }, 1),
      { outcome: 'reset', migrationId: 'm1', detail: 'connect ECONNREFUSED 127.0.0.1:/home/u' }
    )
    expect(props).toMatchObject({
      transition: 'backoff',
      reset_reason: 'host_unreachable',
      attempt_bucket: '1'
    })
    expect(wslMoveOrchestratorSchema.safeParse(props).success).toBe(true)
  })

  it('maps every state to a transition the schema accepts', () => {
    const states: WslMoveOrchestratorRecord['state'][] = [
      { kind: 'idle' },
      { kind: 'pending' },
      { kind: 'deferred', blockers: [], rechecks: 0 },
      { kind: 'moving' },
      { kind: 'waiting-for-host', migrationId: 'm' },
      { kind: 'backoff', nextAttemptAt: 0, reason: 'x' },
      { kind: 'parked', reason: 'not-now', until: 1 },
      { kind: 'parked', reason: 'declined' },
      { kind: 'parked', reason: 'removal-pending' },
      { kind: 'parked', reason: 'stuck' },
      { kind: 'done', migrationId: 'm' },
      { kind: 'distro-gone' },
      { kind: 'restore-offered' }
    ]
    for (const state of states) {
      expect(
        wslMoveOrchestratorSchema.safeParse(wslMoveOrchestratorEventProps('user', record(state)))
          .success
      ).toBe(true)
    }
  })
})
