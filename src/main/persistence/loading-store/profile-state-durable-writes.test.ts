import { describe, vi } from 'vitest'
import { registerProfileStateWorkerCoordinationTests } from './profile-state-worker-coordination.spec'
import { registerProfileStateWorkerSecretRetentionTests } from './profile-state-worker-secret-retention.spec'
import { registerProfileStateWriteBatchingTests } from './profile-state-write-batching.spec'
import { registerPtyBindingAsyncDurabilityTests } from './pty-binding-async-durability.spec'
import { registerPtyBindingCreatedSurfaceRollbackTests } from './pty-binding-created-surface-rollback.spec'
import { registerPtyBindingRestartRetirementTests } from './pty-binding-restart-retirement.spec'
import { registerPtyRetirementAsyncDurabilityTests } from './pty-retirement-async-durability.spec'
import { registerWorkspaceSessionWriteListenersTests } from './workspace-session-write-listeners.spec'
import { registerStateWriteListenersTests } from './state-write-listeners.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('profile-state-worker-coordination', registerProfileStateWorkerCoordinationTests)
describe('profile-state-worker-secret-retention', registerProfileStateWorkerSecretRetentionTests)
describe('profile-state-write-batching', registerProfileStateWriteBatchingTests)
describe('pty-binding-async-durability', registerPtyBindingAsyncDurabilityTests)
describe('pty-binding-created-surface-rollback', registerPtyBindingCreatedSurfaceRollbackTests)
describe('pty-binding-restart-retirement', registerPtyBindingRestartRetirementTests)
describe('pty-retirement-async-durability', registerPtyRetirementAsyncDurabilityTests)
describe('workspace-session-write-listeners', registerWorkspaceSessionWriteListenersTests)
describe('state-write-listeners', registerStateWriteListenersTests)
