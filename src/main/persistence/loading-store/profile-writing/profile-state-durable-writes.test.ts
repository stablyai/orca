import { describe, vi } from 'vitest'
import { registerProfileStateWorkerCoordinationTests } from './profile-state-worker-coordination.spec'
import { registerProfileStateWorkerSecretRetentionTests } from './profile-state-worker-secret-retention.spec'
import { registerProfileStateWriteBatchingTests } from './profile-state-write-batching.spec'
import { registerPtyBindingAsyncDurabilityTests } from '../terminal-bindings/pty-binding-async-durability.spec'
import { registerPtyRetirementAsyncDurabilityTests } from '../terminal-bindings/pty-retirement-async-durability.spec'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('profile-state-worker-coordination', registerProfileStateWorkerCoordinationTests)
describe('profile-state-worker-secret-retention', registerProfileStateWorkerSecretRetentionTests)
describe('profile-state-write-batching', registerProfileStateWriteBatchingTests)
describe('pty-binding-async-durability', registerPtyBindingAsyncDurabilityTests)
describe('pty-retirement-async-durability', registerPtyRetirementAsyncDurabilityTests)
