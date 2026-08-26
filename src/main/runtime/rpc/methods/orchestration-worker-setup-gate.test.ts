import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  applyWaitForSetupOutcome,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import type { WorkerEffect, WorkerSetupReceipt } from './orchestration-worker-topology'

function gatedReceipt(state: WorkerSetupReceipt['state'] = 'running'): WorkerSetupReceipt {
  return {
    requested: 'run',
    effective: 'run',
    source: 'test',
    hookFound: true,
    startupPolicy: 'wait-for-setup',
    state
  }
}

function setupEffects(): WorkerEffect[] {
  return [{ kind: 'setup', action: 'run', state: 'running' }]
}

function createStageDb(): { db: OrchestrationDb; recordWorkerStage: ReturnType<typeof vi.fn> } {
  const recordWorkerStage = vi.fn()
  const db = { recordWorkerStage } as unknown as OrchestrationDb
  return { db, recordWorkerStage }
}

describe('applyWaitForSetupOutcome', () => {
  it('applies succeeded and reports a terminal transition when the wait is satisfied', () => {
    const receipt = gatedReceipt()
    const effects = setupEffects()
    expect(applyWaitForSetupOutcome(receipt, effects, { satisfied: true, status: 'idle' })).toBe(
      true
    )
    expect(receipt.state).toBe('succeeded')
    expect(effects[0]?.state).toBe('succeeded')
  })

  it('applies failed and reports a terminal transition when the setup terminal exited', () => {
    const receipt = gatedReceipt()
    const effects = setupEffects()
    expect(applyWaitForSetupOutcome(receipt, effects, { satisfied: false, status: 'exited' })).toBe(
      true
    )
    expect(receipt.state).toBe('failed')
    expect(effects[0]?.state).toBe('failed')
  })

  it('reports no transition while the wait is unresolved', () => {
    const receipt = gatedReceipt()
    const effects = setupEffects()
    expect(applyWaitForSetupOutcome(receipt, effects, { satisfied: false, status: 'timeout' })).toBe(
      false
    )
    expect(receipt.state).toBe('running')
    expect(effects[0]?.state).toBe('running')
  })

  it('reports no transition for receipts outside the gated running state', () => {
    const receipt = gatedReceipt('spawn_failed')
    expect(applyWaitForSetupOutcome(receipt, setupEffects(), { satisfied: true, status: 'idle' })).toBe(
      false
    )
    expect(receipt.state).toBe('spawn_failed')
  })

  it('reports no transition for start-immediately receipts', () => {
    const receipt = { ...gatedReceipt(), startupPolicy: 'start-immediately' as const }
    expect(applyWaitForSetupOutcome(receipt, setupEffects(), { satisfied: true, status: 'idle' })).toBe(
      false
    )
    expect(receipt.state).toBe('running')
  })
})

describe('persistWorkerSetupWaitOutcome', () => {
  it('records setup_settled only after a terminal transition', () => {
    const { db, recordWorkerStage } = createStageDb()
    persistWorkerSetupWaitOutcome({
      db,
      dispatchId: 'dispatch_ok',
      worktreeId: 'worktree_ok',
      terminalHandle: 'term_ok',
      setup: gatedReceipt(),
      effects: setupEffects(),
      wait: { satisfied: true, status: 'idle' }
    })
    expect(recordWorkerStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'setup_settled', setupState: 'succeeded' })
    )
  })

  it('records setup_failed when the setup terminal exited unsuccessfully', () => {
    const { db, recordWorkerStage } = createStageDb()
    persistWorkerSetupWaitOutcome({
      db,
      dispatchId: 'dispatch_failed',
      worktreeId: 'worktree_failed',
      terminalHandle: 'term_failed',
      setup: gatedReceipt(),
      effects: setupEffects(),
      wait: { satisfied: false, status: 'exited' }
    })
    expect(recordWorkerStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'setup_failed', setupState: 'failed' })
    )
  })

  it('records nothing while the wait is unresolved', () => {
    const { db, recordWorkerStage } = createStageDb()
    persistWorkerSetupWaitOutcome({
      db,
      dispatchId: 'dispatch_pending',
      worktreeId: 'worktree_pending',
      terminalHandle: 'term_pending',
      setup: gatedReceipt(),
      effects: setupEffects(),
      wait: { satisfied: false, status: 'timeout' }
    })
    expect(recordWorkerStage).not.toHaveBeenCalled()
  })

  it('records nothing when the receipt already left the running state', () => {
    const { db, recordWorkerStage } = createStageDb()
    persistWorkerSetupWaitOutcome({
      db,
      dispatchId: 'dispatch_spawn_failed',
      worktreeId: 'worktree_spawn_failed',
      terminalHandle: 'term_spawn_failed',
      setup: gatedReceipt('spawn_failed'),
      effects: setupEffects(),
      wait: { satisfied: false, status: 'timeout' }
    })
    expect(recordWorkerStage).not.toHaveBeenCalled()
  })
})
