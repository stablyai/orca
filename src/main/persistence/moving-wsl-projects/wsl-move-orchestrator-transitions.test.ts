import { describe, expect, it } from 'vitest'
import type {
  WslMoveBlocker,
  WslMoveRefusalCode
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  applyWslMoveOutcome,
  classifyWslMoveOutcome,
  mayStartWslMove,
  newWslMoveOrchestratorRecord,
  sameWslMoveOrchestratorRecord,
  WSL_MOVE_ORCHESTRATOR_BACKOFF_MS,
  WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS,
  WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS,
  WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS,
  WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS,
  WSL_MOVE_ORCHESTRATOR_UNCOUNTED_WAIT_LIMIT,
  wslMoveOrchestratorTimerDelay
} from './wsl-move-orchestrator-transitions'
import {
  applyWslMovedDistroVerdict,
  applyWslMoveHostAddedByUser,
  applyWslMoveHostRemovalPending,
  applyWslMoveReleasedByUser,
  applyWslMoveUserAction,
  settleWslMoveOrchestratorRecord
} from './wsl-move-orchestrator-external-transitions'

const NOW = 1_000_000
const context = { now: NOW, appVersion: '1.0.0', trigger: 'connect' as const }
const blocker: WslMoveBlocker = {
  kind: 'agent-working',
  ids: ['tab:leaf'],
  actions: ['wait', 'end']
}

function record(
  state: WslMoveOrchestratorRecord['state'],
  attempts = 0
): WslMoveOrchestratorRecord {
  return { ...newWslMoveOrchestratorRecord('Ubuntu', '1.0.0', 0), state, attempts }
}

function refused(code: WslMoveRefusalCode) {
  return classifyWslMoveOutcome({ outcome: 'refused', code })
}

describe('classifyWslMoveOutcome', () => {
  it('starts a ready preview and defers one with blockers', () => {
    const ready = {
      outcome: 'ready' as const,
      distro: 'Ubuntu',
      repoIds: ['r1'],
      folderWorkspaceIds: [],
      changed: [],
      heldByHost: [],
      refused: []
    }
    expect(classifyWslMoveOutcome({ ...ready, blockers: [] })).toEqual({ next: 'start' })
    expect(classifyWslMoveOutcome({ ...ready, blockers: [blocker] })).toEqual({
      next: 'deferred',
      blockers: [blocker]
    })
  })

  it('parks what needs the user and backs off what may pass on its own', () => {
    expect(refused('wsl_move_export_incomplete')).toEqual({
      next: 'parked',
      reason: 'export-incomplete'
    })
    expect(refused('wsl_move_manifest_too_large')).toEqual({
      next: 'parked',
      reason: 'manifest-too-large'
    })
    expect(refused('wsl_move_cancelled')).toEqual({ next: 'parked', reason: 'not-now' })
    for (const code of [
      'wsl_move_host_unavailable',
      'wsl_move_already_in_flight',
      'wsl_move_pause_failed',
      'wsl_move_scope_changed',
      'wsl_move_finished_earlier_move',
      'wsl_move_host_update_required'
    ] as const) {
      expect(refused(code)).toEqual({ next: 'transient', reason: code })
    }
    expect(refused('wsl_move_nothing_new')).toEqual({ next: 'idle' })
    expect(refused('wsl_move_already_running')).toEqual({ next: 'stay' })
    expect(
      classifyWslMoveOutcome({
        outcome: 'refused',
        code: 'wsl_move_terminals_blocked',
        blockers: [blocker]
      })
    ).toEqual({ next: 'deferred', blockers: [blocker] })
  })

  it('maps the move results', () => {
    expect(
      classifyWslMoveOutcome({
        outcome: 'moved',
        migrationId: 'm1',
        phase: 'retained',
        reloadRequired: true
      })
    ).toEqual({ next: 'done', migrationId: 'm1' })
    expect(
      classifyWslMoveOutcome({ outcome: 'reset', migrationId: 'm1', detail: 'host_unreachable' })
    ).toEqual({ next: 'transient', reason: 'host_unreachable' })
    expect(
      classifyWslMoveOutcome({ outcome: 'waiting-for-host', migrationId: 'm1', detail: 'x' })
    ).toEqual({ next: 'waiting', migrationId: 'm1' })
  })
})

describe('mayStartWslMove', () => {
  it('never starts a running move, even for the user', () => {
    expect(mayStartWslMove(record({ kind: 'moving' }), 'user', NOW, '1.0.0')).toBe(false)
  })

  it('waits out a backoff unless the user asks', () => {
    const waiting = record({ kind: 'backoff', nextAttemptAt: NOW + 1, reason: 'x' })
    expect(mayStartWslMove(waiting, 'timer', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(waiting, 'timer', NOW + 1, '1.0.0')).toBe(true)
    expect(mayStartWslMove(waiting, 'user', NOW, '1.0.0')).toBe(true)
  })

  it('keeps a parked move parked until the user, its snooze or a new build', () => {
    const snoozed = record({ kind: 'parked', reason: 'not-now', until: NOW + 10 })
    expect(mayStartWslMove(snoozed, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(snoozed, 'connect', NOW + 10, '1.0.0')).toBe(true)
    const exhausted = record({ kind: 'parked', reason: 'attempts-exhausted' }, 5)
    expect(mayStartWslMove(exhausted, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(exhausted, 'connect', NOW, '1.1.0')).toBe(true)
    const tooLarge = record({ kind: 'parked', reason: 'manifest-too-large' })
    expect(mayStartWslMove(tooLarge, 'connect', NOW, '1.1.0')).toBe(false)
    expect(mayStartWslMove(tooLarge, 'user', NOW, '1.0.0')).toBe(true)
  })

  it('never starts on its own for a gone or replaced distro (R38)', () => {
    expect(mayStartWslMove(record({ kind: 'distro-gone' }), 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(record({ kind: 'distro-gone' }), 'user', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(record({ kind: 'restore-offered' }), 'connect', NOW, '1.0.0')).toBe(
      false
    )
  })
})

describe('applyWslMoveOutcome', () => {
  it('backs off on the schedule, then parks once attempts run out', () => {
    let current = record({ kind: 'pending' })
    for (let attempt = 1; attempt < WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS; attempt++) {
      current = applyWslMoveOutcome(current, { next: 'transient', reason: 'x' }, context)
      expect(current.state).toEqual({
        kind: 'backoff',
        nextAttemptAt: NOW + WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[attempt - 1],
        reason: 'x'
      })
      expect(current.attempts).toBe(attempt)
    }
    current = applyWslMoveOutcome(current, { next: 'transient', reason: 'x' }, context)
    expect(current.state).toEqual({ kind: 'parked', reason: 'attempts-exhausted' })
  })

  it('starts a fresh count on a new build', () => {
    const old = { ...record({ kind: 'pending' }, 4), appVersion: '0.9.0' }
    const next = applyWslMoveOutcome(old, { next: 'transient', reason: 'x' }, context)
    expect(next.attempts).toBe(1)
    expect(next.appVersion).toBe('1.0.0')
  })

  it('parks a host that still needs an update after one retry', () => {
    const reason = 'wsl_move_host_update_required'
    const first = applyWslMoveOutcome(
      record({ kind: 'pending' }),
      { next: 'transient', reason },
      context
    )
    expect(first.state.kind).toBe('backoff')
    const second = applyWslMoveOutcome(first, { next: 'transient', reason }, context)
    expect(second.state).toEqual({ kind: 'parked', reason: 'host-update-required' })
  })

  it('snoozes a cancelled move for a week', () => {
    const next = applyWslMoveOutcome(
      record({ kind: 'moving' }),
      { next: 'parked', reason: 'not-now' },
      context
    )
    expect(next.state).toEqual({
      kind: 'parked',
      reason: 'not-now',
      until: NOW + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS
    })
  })

  it('keeps a finished distro done when there is nothing new to move', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    expect(applyWslMoveOutcome(done, { next: 'idle' }, context)).toBe(done)
    expect(
      applyWslMoveOutcome(record({ kind: 'pending' }), { next: 'idle' }, context).state
    ).toEqual({ kind: 'idle' })
  })

  it('clears the attempt count on success', () => {
    const next = applyWslMoveOutcome(
      record({ kind: 'moving' }, 3),
      { next: 'done', migrationId: 'm1' },
      context
    )
    expect(next).toMatchObject({ state: { kind: 'done', migrationId: 'm1' }, attempts: 0 })
  })
})

describe('R38 verdicts and user actions', () => {
  it('marks a gone or replaced distro and recovers one registered again', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    expect(applyWslMovedDistroVerdict(done, 'gone', NOW).state).toEqual({ kind: 'distro-gone' })
    expect(applyWslMovedDistroVerdict(done, 'replaced', NOW).state).toEqual({
      kind: 'restore-offered'
    })
    expect(applyWslMovedDistroVerdict(done, 'unknown', NOW)).toBe(done)
    expect(applyWslMovedDistroVerdict(done, 'present', NOW)).toBe(done)
    expect(
      applyWslMovedDistroVerdict(record({ kind: 'distro-gone' }), 'present', NOW).state
    ).toEqual({ kind: 'pending' })
  })

  it('applies Retry, Not now and Restore, and leaves a running move alone', () => {
    const parked = record({ kind: 'parked', reason: 'attempts-exhausted' }, 5)
    expect(applyWslMoveUserAction(parked, 'retry', NOW, '1.0.0')).toMatchObject({
      state: { kind: 'pending' },
      attempts: 0
    })
    expect(applyWslMoveUserAction(parked, 'not-now', NOW, '1.0.0').state).toEqual({
      kind: 'parked',
      reason: 'not-now',
      until: NOW + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS
    })
    const moving = record({ kind: 'moving' })
    expect(applyWslMoveUserAction(moving, 'not-now', NOW, '1.0.0')).toBe(moving)
  })

  it('reads a move left running by an earlier process as pending', () => {
    expect(settleWslMoveOrchestratorRecord(record({ kind: 'moving' }), NOW, true).state).toEqual({
      kind: 'pending'
    })
    const deferred = record({ kind: 'deferred', blockers: [blocker], rechecks: 0 })
    expect(settleWslMoveOrchestratorRecord(deferred, NOW, false)).toBe(deferred)
  })
})

describe('review fixes (#33802)', () => {
  // 1: a clean preview marks the run; a start another run already owns must not keep it marked.
  it('puts a run refused as already running back to pending', () => {
    const next = applyWslMoveOutcome(record({ kind: 'moving' }), { next: 'stay' }, context)
    expect(next.state).toEqual({ kind: 'pending' })
    const idle = record({ kind: 'idle' })
    expect(applyWslMoveOutcome(idle, { next: 'stay' }, context)).toBe(idle)
  })

  // 2: "Use on this computer again" is a deliberate no, with no expiry.
  it('parks a distro the user brought back until Retry', () => {
    const declined = applyWslMoveReleasedByUser(
      record({ kind: 'done', migrationId: 'm1' }),
      NOW,
      'released-here'
    )
    expect(declined.state).toEqual({ kind: 'parked', reason: 'declined', cause: 'released-here' })
    expect(mayStartWslMove(declined, 'project-opened', NOW + 365 * 86_400_000, '9.0.0')).toBe(false)
    expect(mayStartWslMove(declined, 'user', NOW, '1.0.0')).toBe(true)
  })

  // 4: deferred re-checks back off 1 m, 5 m, 30 m, then only a wake or the user re-checks.
  it('spends the deferred re-check series on timers only, and a wake restarts it', () => {
    let current = record({ kind: 'pending' })
    const delays: (number | null)[] = []
    current = applyWslMoveOutcome(current, { next: 'deferred', blockers: [blocker] }, context)
    for (let check = 0; check < 4; check++) {
      delays.push(wslMoveOrchestratorTimerDelay(current, NOW))
      current = applyWslMoveOutcome(
        current,
        { next: 'deferred', blockers: [blocker] },
        { ...context, trigger: 'timer' }
      )
    }
    expect(delays).toEqual([...WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS, null])
    const woken = applyWslMoveOutcome(current, { next: 'deferred', blockers: [blocker] }, context)
    expect(wslMoveOrchestratorTimerDelay(woken, NOW)).toBe(
      WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0]
    )
  })

  // 6: once the host-catalog check reports `present`, an offered Restore is withdrawn.
  it('clears an offered Restore when the distro reads present', () => {
    expect(
      applyWslMovedDistroVerdict(record({ kind: 'restore-offered' }), 'present', NOW).state
    ).toEqual({ kind: 'pending' })
  })

  // 7: failing to ask the window says nothing about the move.
  it('retries a window that could not be asked without spending an attempt', () => {
    const next = applyWslMoveOutcome(
      record({ kind: 'pending' }, 2),
      { next: 'transient', reason: 'wsl_move_window_unavailable' },
      context
    )
    expect(next.attempts).toBe(2)
    expect(next.state).toMatchObject({ kind: 'backoff', reason: 'wsl_move_window_unavailable' })
  })

  // 8: the 6 h step runs; the attempt after it parks.
  it('waits 6 h after the fifth failure and parks on the sixth', () => {
    const fifth = applyWslMoveOutcome(
      record({ kind: 'backoff', nextAttemptAt: 0, reason: 'x' }, 4),
      { next: 'transient', reason: 'x' },
      context
    )
    expect(fifth.state).toEqual({
      kind: 'backoff',
      nextAttemptAt: NOW + 6 * 60 * 60_000,
      reason: 'x'
    })
    const sixth = applyWslMoveOutcome(fifth, { next: 'transient', reason: 'x' }, context)
    expect(sixth.state).toEqual({ kind: 'parked', reason: 'attempts-exhausted' })
  })

  // 8: a host that needed an update gets one retry per new build, then waits again.
  it('retries a host that needed an update once on a new build', () => {
    const parked = record({ kind: 'parked', reason: 'host-update-required' }, 2)
    expect(mayStartWslMove(parked, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(parked, 'connect', NOW, '1.1.0')).toBe(true)
    const again = applyWslMoveOutcome(
      parked,
      { next: 'transient', reason: 'wsl_move_host_update_required' },
      { ...context, appVersion: '1.1.0' }
    )
    expect(again.state).toEqual({ kind: 'parked', reason: 'host-update-required' })
    expect(mayStartWslMove(again, 'connect', NOW, '1.1.0')).toBe(false)
  })

  // 9: a Restore whose release finished before the app quit has nothing left to offer.
  it('reads an offered Restore with no finished move left as pending', () => {
    const offered = record({ kind: 'restore-offered' })
    expect(settleWslMoveOrchestratorRecord(offered, NOW, false).state).toEqual({ kind: 'pending' })
    expect(settleWslMoveOrchestratorRecord(offered, NOW, true)).toBe(offered)
  })

  it('treats records that differ only in their write time as the same', () => {
    const a = record({ kind: 'deferred', blockers: [blocker], rechecks: 1 })
    expect(sameWslMoveOrchestratorRecord(a, { ...a, updatedAt: a.updatedAt + 1 })).toBe(true)
    expect(sameWslMoveOrchestratorRecord(a, { ...a, attempts: 1 })).toBe(false)
  })

  it('parks a host whose Remove is pending for every automatic trigger and new build', () => {
    const parked = applyWslMoveHostRemovalPending(record({ kind: 'done', migrationId: 'm1' }), NOW)
    expect(parked.state).toEqual({ kind: 'parked', reason: 'removal-pending' })
    for (const trigger of ['connect', 'project-opened', 'startup', 'timer'] as const) {
      expect(mayStartWslMove(parked, trigger, NOW + 365 * 86_400_000, '9.0.0')).toBe(false)
    }
  })

  it('takes back only a decline when the user adds the host', () => {
    const declined = record({ kind: 'parked', reason: 'declined', cause: 'released-here' })
    expect(applyWslMoveHostAddedByUser(declined, NOW).state).toEqual({ kind: 'pending' })
    const snoozed = record({ kind: 'parked', reason: 'not-now', until: NOW })
    expect(applyWslMoveHostAddedByUser(snoozed, NOW)).toBe(snoozed)
  })

  // Found by the orchestrator-over-driver test: after a move, until retention marks it retained,
  // the driver refuses new moves as already in flight. That is waiting, not a failed attempt.
  it('keeps a finished distro done while its move is still being retained, and re-checks', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    const reason = 'wsl_move_already_in_flight'
    const waiting = applyWslMoveOutcome(done, { next: 'transient', reason }, context)
    expect(waiting.state).toEqual({
      kind: 'done',
      migrationId: 'm1',
      nextCheckAt: NOW + WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS,
      waits: 1
    })
    expect(wslMoveOrchestratorTimerDelay(waiting, NOW)).toBe(
      WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS
    )
    // Retention done: nothing new to move ends the wait.
    expect(applyWslMoveOutcome(waiting, { next: 'idle' }, context).state).toEqual({
      kind: 'done',
      migrationId: 'm1'
    })
    const pending = applyWslMoveOutcome(
      record({ kind: 'pending' }, 2),
      { next: 'transient', reason },
      context
    )
    expect(pending).toMatchObject({ attempts: 2, state: { kind: 'backoff', reason } })
  })

  it('keeps a finished distro done when the window cannot be asked', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    const next = applyWslMoveOutcome(
      done,
      { next: 'transient', reason: 'wsl_move_window_unavailable' },
      context
    )
    expect(next).toMatchObject({ attempts: 0, state: { kind: 'done', migrationId: 'm1' } })
  })

  // An in-flight refusal for an interrupted move whose host could not be asked is a real failure.
  it('counts an in-flight refusal that carries the reset detail', () => {
    const outcome = classifyWslMoveOutcome({
      outcome: 'refused',
      code: 'wsl_move_already_in_flight',
      detail: 'destination_unreachable'
    })
    expect(outcome).toEqual({
      next: 'transient',
      reason: 'wsl_move_already_in_flight_unverifiable'
    })
    expect(applyWslMoveOutcome(record({ kind: 'pending' }), outcome, context).attempts).toBe(1)
  })

  it('parks as stuck after a day of uncounted checks, for a backoff and for a done distro', () => {
    const reason = 'wsl_move_already_in_flight'
    const last = WSL_MOVE_ORCHESTRATOR_UNCOUNTED_WAIT_LIMIT - 1
    const waitingBackoff = record({ kind: 'backoff', nextAttemptAt: NOW, reason, waits: last - 1 })
    expect(
      applyWslMoveOutcome(waitingBackoff, { next: 'transient', reason }, context).state
    ).toMatchObject({ kind: 'backoff', waits: last })
    const atCap = record({ kind: 'backoff', nextAttemptAt: NOW, reason, waits: last })
    expect(applyWslMoveOutcome(atCap, { next: 'transient', reason }, context).state).toEqual({
      kind: 'parked',
      reason: 'stuck'
    })
    const waitingDone = record({ kind: 'done', migrationId: 'm1', nextCheckAt: NOW, waits: last })
    const stuck = applyWslMoveOutcome(waitingDone, { next: 'transient', reason }, context)
    expect(stuck.state).toEqual({ kind: 'parked', reason: 'stuck' })
    expect(mayStartWslMove(stuck, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(stuck, 'user', NOW, '1.0.0')).toBe(true)
  })

  // Review: a weekend with the app closed must not park a distro on its first check after launch.
  it('does not park on the first check after days with the app closed', () => {
    const reason = 'wsl_move_already_in_flight'
    const waiting = record({ kind: 'done', migrationId: 'm1', nextCheckAt: NOW, waits: 3 })
    const afterWeekend = { ...context, now: NOW + 3 * 24 * 60 * 60_000 }
    const next = applyWslMoveOutcome(waiting, { next: 'transient', reason }, afterWeekend)
    expect(next.state).toMatchObject({ kind: 'done', waits: 4 })
  })

  it('counts an in-flight refusal whose detail is an empty string', () => {
    expect(
      classifyWslMoveOutcome({ outcome: 'refused', code: 'wsl_move_already_in_flight', detail: '' })
    ).toEqual({ next: 'transient', reason: 'wsl_move_already_in_flight_unverifiable' })
  })
})
