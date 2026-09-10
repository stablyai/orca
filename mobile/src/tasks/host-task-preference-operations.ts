import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { HostTaskBootstrap, HostTaskSettingsUpdate } from './host-task-runtime-payloads'

export type { HostTaskSettingsUpdate }

export type HostTaskPreferenceOperations = {
  updateResume(taskResumeState: HostTaskBootstrap['taskResumeState']): Promise<void>
  updateSettings(settings: Partial<HostTaskSettingsUpdate>): Promise<void>
  persistSetupTrust(args: {
    trust: PersistedTrustedOrcaHooks
    repoId: string
    contentHash: string
    alwaysTrust: boolean
  }): Promise<PersistedTrustedOrcaHooks>
}
