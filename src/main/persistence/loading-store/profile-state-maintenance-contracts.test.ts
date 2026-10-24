import { describe, vi } from 'vitest'
import { registerDurableSettingsWriteTests } from './durable-settings-write.spec'
import { registerProfileStateCallerCancellationTests } from './profile-state-caller-cancellation.spec'
import { registerProfileStateMaintenanceFinalFailureTests } from './profile-state-maintenance-final-failure.spec'
import { registerProfileStateMaintenanceRecoveryTests } from './profile-state-maintenance-recovery.spec'
import {
  registerProfileStateMaintenanceCompatibilityTests,
  registerProfileStateMaintenanceTests
} from './profile-state-maintenance.spec'
import { registerProfileStatePtyRetirementFinalizationTests } from './profile-state-pty-retirement-finalization.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('durable-settings-write', registerDurableSettingsWriteTests)
describe('profile-state-caller-cancellation', registerProfileStateCallerCancellationTests)
describe(
  'profile-state-maintenance-final-failure',
  registerProfileStateMaintenanceFinalFailureTests
)
describe('profile-state-maintenance-recovery', registerProfileStateMaintenanceRecoveryTests)
describe('profile-state-maintenance', registerProfileStateMaintenanceTests)
describe(
  'profile-state-pty-retirement-finalization',
  registerProfileStatePtyRetirementFinalizationTests
)

describe(
  'profile maintenance without compatibility snapshots',
  registerProfileStateMaintenanceCompatibilityTests
)
