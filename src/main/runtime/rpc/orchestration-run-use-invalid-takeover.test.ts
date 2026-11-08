import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
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
})
