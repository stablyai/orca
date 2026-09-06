import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { MobileWebTaskSettingsUpdatePayload } from '../../../src/shared/mobile-web/task-read-contract'
import type { HostTaskBootstrap } from './host-task-read-operations'

export type HostTaskSettingsUpdate = MobileWebTaskSettingsUpdatePayload

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
