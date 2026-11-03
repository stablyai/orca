import type { MobileWebBundleManifestRead } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type {
  MobileWebBundleFetchResult,
  MobileWebBundleReusableAssets
} from '../transport/web-bundle/mobile-web-bundle-fetch'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'

export type ActiveGeneration = {
  readonly buildId: string
  // The native view reads this tree; only the store may write it.
  readonly directory: string
  readonly manifest: MobileWebBundleManifestRead
  readonly activationRevision?: number
}

export type StagedGeneration = {
  readonly hostKey: string
  readonly buildId: string
  readonly directory: string
  readonly manifest: MobileWebBundleManifestRead
}

export type GenerationLease = { readonly generation: ActiveGeneration }

export type GenerationStore = {
  acquireGeneration(
    hostKey: string,
    generation: Pick<ActiveGeneration, 'buildId' | 'activationRevision'>
  ): Promise<GenerationLease | null>
  releaseGeneration(lease: GenerationLease): void
  confirmGeneration(lease: GenerationLease, isCurrentDocument: () => boolean): Promise<void>
  rejectGeneration(lease: GenerationLease): Promise<void>
  readActiveGeneration(hostKey: string): Promise<ActiveGeneration | null>
  openReusableAssets(hostKey: string): Promise<MobileWebBundleReusableAssets>
  stageGeneration(
    hostKey: string,
    result: MobileWebBundleFetchResult,
    signal?: AbortSignal,
    reusable?: MobileWebBundleReusableAssets
  ): Promise<StagedGeneration>
  commitGeneration(staged: StagedGeneration): Promise<GenerationLease>
  abortStagedGeneration(staged: StagedGeneration): Promise<void>
  sweepStagedGenerations(): Promise<void>
  deleteHostCache(hostKey: string): Promise<void>
  // Best-effort Troubleshoot evidence; must never reject.
  recordUpdateFailure(failure: MobileWebShellUpdateFailure): Promise<void>
  // Oldest first; unreadable logs count as empty.
  readUpdateFailures(): Promise<readonly MobileWebShellUpdateFailure[]>
  // Key by host id so evidence outlives cached generations; never reject.
  forgetHostUpdateFailures(hostId: string): Promise<void>
}
