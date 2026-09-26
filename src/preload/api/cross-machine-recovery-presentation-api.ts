import type {
  RecoveryPresentationPublishParams,
  RecoveryPresentationPublishResult
} from '../../shared/cross-machine-recovery-presentation-types'

export type CrossMachineRecoveryPresentationApi = {
  /** Null on web, which has no local Electron host to publish to. */
  publishLocal:
    | ((params: RecoveryPresentationPublishParams) => Promise<RecoveryPresentationPublishResult>)
    | null
  getClientInstanceId: () => Promise<string>
  getClientName: () => Promise<string>
}
