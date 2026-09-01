import { describe, expect, it } from 'vitest'
import {
  reconcileAgentLaunchLiveness,
  retryRecoveryGateForFailureCode
} from './agent-launch-reconciliation'

describe('reconcileAgentLaunchLiveness', () => {
  it('live + attributed settles launched', () => {
    expect(reconcileAgentLaunchLiveness({ kind: 'live', attributed: true })).toEqual({
      kind: 'launched'
    })
  })

  it('live + unattributed records invalid_launch_snapshot', () => {
    expect(reconcileAgentLaunchLiveness({ kind: 'live', attributed: false })).toEqual({
      kind: 'invalid_launch_snapshot'
    })
  })

  it('absent settles spawn_failed so retry becomes available', () => {
    expect(reconcileAgentLaunchLiveness({ kind: 'absent' })).toEqual({ kind: 'spawn_failed' })
  })

  it('unknown keeps the launch pending as launch_state_unknown', () => {
    expect(reconcileAgentLaunchLiveness({ kind: 'unknown' })).toEqual({
      kind: 'launch_state_unknown'
    })
  })
})

describe('retryRecoveryGateForFailureCode', () => {
  it('blocks retry while liveness is unknown', () => {
    expect(retryRecoveryGateForFailureCode('launch_state_unknown')).toEqual({
      kind: 'launch_state_unknown'
    })
  })

  it('blocks retry while a token-live terminal lacks attribution', () => {
    expect(retryRecoveryGateForFailureCode('invalid_launch_snapshot')).toEqual({
      kind: 'invalid_launch_snapshot'
    })
  })

  it('treats an ordinary spawn failure as retryable', () => {
    expect(retryRecoveryGateForFailureCode('spawn_failed')).toEqual({ kind: 'retryable' })
  })

  it('treats an absent durable failure as retryable', () => {
    expect(retryRecoveryGateForFailureCode(undefined)).toEqual({ kind: 'retryable' })
  })
})
