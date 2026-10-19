import { describe, expect, it } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import {
  registerManagedServerActions,
  type ManagedServerActions
} from '../managed-server-actions-registry'

describe('managed server capability', () => {
  // A runtime without the desktop's SSH registry must not point clients at methods that refuse.
  it('is advertised only where the desktop registered the managed-server actions', () => {
    registerManagedServerActions(null)
    expect(createRuntime().getStatus().capabilities).not.toContain('managedServer.v1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getStatus only checks that actions are registered.
    registerManagedServerActions({} as ManagedServerActions)
    try {
      expect(createRuntime().getStatus().capabilities).toContain('managedServer.v1')
    } finally {
      registerManagedServerActions(null)
    }
  })
})
