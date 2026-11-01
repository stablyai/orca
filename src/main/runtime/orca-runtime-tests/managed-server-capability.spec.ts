import { describe, expect, it } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import {
  registerManagedServerActions,
  type ManagedServerActions
} from '../managed-server-actions-registry'

describe('managed server capability', () => {
  // Without desktop SSH registry, never advertise methods that can only refuse.
  it('is advertised only where the desktop registered the managed-server actions', () => {
    registerManagedServerActions(null)
    expect(createRuntime().getStatus().capabilities).not.toContain('managedServer.v1')
    const unusedAction = async (): Promise<never> => {
      throw new Error('Capability discovery must not invoke managed-server actions')
    }
    const actions: ManagedServerActions = {
      status: unusedAction,
      update: unusedAction,
      rollback: unusedAction,
      recover: unusedAction,
      stop: unusedAction,
      cancelStop: unusedAction,
      forget: unusedAction
    }
    registerManagedServerActions(actions)
    try {
      expect(createRuntime().getStatus().capabilities).toContain('managedServer.v1')
    } finally {
      registerManagedServerActions(null)
    }
  })
})
