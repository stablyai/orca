import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  updateTarget: vi.fn(),
  setStatus: vi.fn()
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.5.0' })
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ updateTarget: mocks.updateTarget })
}))
vi.mock('../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: mocks.setStatus }))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: null, getCurrentMainWindow: () => null }))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastSshState: vi.fn(),
  getPublicSshState: vi.fn()
}))

const { recordRelayDecision } = await import('./ssh-host-server-connect')

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
const live = { route: 'relay' as const, reason: 'relay_terminals_live' as const, terminals: 2 }

beforeEach(() => vi.clearAllMocks())

describe('recording why a connect kept the relay', () => {
  it('records the first offer this version and marks the status for the toast', () => {
    recordRelayDecision(target, live)
    expect(mocks.updateTarget).toHaveBeenCalledWith('ssh-1', {
      managedServerMoveOffered: { appVersion: '1.5.0' }
    })
    expect(mocks.setStatus).toHaveBeenCalledWith('ssh-1', {
      kind: 'relay',
      reason: 'relay_terminals_live',
      terminals: 2,
      offerMove: true
    })
  })

  it('keeps the status line offer but skips the toast once this version offered it', () => {
    recordRelayDecision({ ...target, managedServerMoveOffered: { appVersion: '1.5.0' } }, live)
    expect(mocks.updateTarget).not.toHaveBeenCalled()
    expect(mocks.setStatus).toHaveBeenCalledWith('ssh-1', {
      kind: 'relay',
      reason: 'relay_terminals_live',
      terminals: 2
    })
  })
})
