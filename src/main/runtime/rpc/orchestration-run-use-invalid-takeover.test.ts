import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  CURRENT_WORKER_HANDLE,
  CURRENT_WORKER_PANE,
  request,
  type LegacyCompatibilityDispatcherHarness
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

function snapshot(harness: LegacyCompatibilityDispatcherHarness) {
  return Object.fromEntries(
    [
      'runs',
      'run_coordinator_handles',
      'messages',
      'deliveries',
      'dispatch_contexts',
      'legacy_adoptions',
      'legacy_compatibility_principals',
      'legacy_operation_receipts',
      'legacy_mail_receipts',
      'mutation_receipts'
    ].map((table) => [table, harness.db.db.prepare(`SELECT * FROM ${table}`).all()])
  )
}

// The coordinator's current binding makes any unbinding visible in the snapshot.
function createOrdinaryTarget(harness: LegacyCompatibilityDispatcherHarness) {
  harness.db.createRun({
    objective: 'current binding',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  })
  return harness.db.createRun({
    objective: 'ordinary target',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
}

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('run-use rejects legacy takeover of ordinary runs', () => {
  it.each(['absent', 'valid'] as const)(
    'returns invalid_argument with %s authority and preserves the database and waiters',
    async (authority) => {
      const harness = createHarness()
      const target = createOrdinaryTarget(harness)
      const before = snapshot(harness)
      const cancel = vi.spyOn(harness.runtime, 'cancelMessageWaiters')
      const rpc = request(
        'orchestration.runUse',
        { id: target.id, from: CURRENT_COORDINATOR_HANDLE, takeoverLegacy: true },
        currentEvidence('coordinator'),
        `ordinary-takeover-${authority}`
      )
      const response = await harness.dispatcher.dispatch({
        ...rpc,
        orchestrationCompatibilityEvidence:
          authority === 'valid' ? rpc.orchestrationCompatibilityEvidence : undefined
      })

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Legacy takeover is only available for the automatically adopted Run.'
        }
      })
      expect(snapshot(harness)).toEqual(before)
      expect(cancel).not.toHaveBeenCalled()
    }
  )

  it('fences another terminal before validating the takeover target', async () => {
    const harness = createHarness()
    const target = createOrdinaryTarget(harness)
    const before = snapshot(harness)
    const cancel = vi.spyOn(harness.runtime, 'cancelMessageWaiters')

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: target.id, from: CURRENT_COORDINATOR_HANDLE, takeoverLegacy: true },
        currentEvidence('worker'),
        'foreign-ordinary-takeover'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(snapshot(harness)).toEqual(before)
    expect(cancel).not.toHaveBeenCalled()
  })

  it.each([
    ['own', 'worker_cannot_coordinate_own_run'],
    ['unrelated', 'worker_cannot_take_over_run']
  ] as const)('preserves the worker refusal for an %s run', async (relationship, code) => {
    const harness = createHarness()
    const target = createOrdinaryTarget(harness)
    const assigned = harness.db.createRun({
      objective: 'worker assignment',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const task = harness.db.createTask({
      runId: assigned.id,
      spec: 'delegated work',
      createdByTerminalHandle: CURRENT_COORDINATOR_HANDLE
    })
    createRootDispatch(harness.db, task.id, CURRENT_WORKER_HANDLE, CURRENT_WORKER_PANE)
    const before = snapshot(harness)
    const cancel = vi.spyOn(harness.runtime, 'cancelMessageWaiters')

    const response = await harness.dispatcher.dispatch({
      ...request(
        'orchestration.runUse',
        {
          id: relationship === 'own' ? assigned.id : target.id,
          from: CURRENT_WORKER_HANDLE,
          takeoverLegacy: true
        },
        currentEvidence('worker'),
        `worker-${relationship}-takeover`
      ),
      orchestrationCompatibilityEvidence: undefined
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code, data: { effectsApplied: false } }
    })
    expect(snapshot(harness)).toEqual(before)
    expect(cancel).not.toHaveBeenCalled()
  })

  it.each(['missing', 'inspect-only'] as const)(
    'keeps authority-first refusal and run_not_found for an authorized %s target',
    async (targetKind) => {
      const harness = createHarness()
      const target = harness.db.createRun({
        objective: 'inspect-only target',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      harness.db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(target.id)
      const id = targetKind === 'missing' ? 'run_missing' : target.id
      const before = snapshot(harness)
      const cancel = vi.spyOn(harness.runtime, 'cancelMessageWaiters')
      const rpc = request(
        'orchestration.runUse',
        { id, from: CURRENT_COORDINATOR_HANDLE, takeoverLegacy: true },
        currentEvidence('coordinator'),
        `${targetKind}-takeover`
      )

      const unauthorized = await harness.dispatcher.dispatch({
        ...rpc,
        orchestrationCompatibilityEvidence: undefined
      })
      expect(unauthorized).toMatchObject({
        ok: false,
        error: { code: 'legacy_read_only', data: { effectsApplied: false } }
      })
      expect(await harness.dispatcher.dispatch(rpc)).toMatchObject({
        ok: false,
        error: { code: 'run_not_found' }
      })
      expect(snapshot(harness)).toEqual(before)
      expect(cancel).not.toHaveBeenCalled()
    }
  )
})
