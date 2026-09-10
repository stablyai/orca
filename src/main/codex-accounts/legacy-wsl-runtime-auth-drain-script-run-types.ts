// Why: the interference knobs and the observable result surface of a real apply-script run,
// kept beside the harness so neither module carries both the contract and the machinery.
export type DrainApplyInterference = {
  crossFilesystemBridge?: boolean
  deleteSource?: boolean
  killAfterDestinationInstall?: boolean
  killBeforeDestinationRecoveryLink?: boolean
  killAfterSessionLink?: boolean
  killAfterSourceRemoval?: boolean
  killDuringSessionCommit?: boolean
  promoteAuth?: boolean
  replaceTargetAfterSessionLink?: boolean
  replaceTargetOnHashOf?: string
  replaceTargetBeforeRecovery?: boolean
  rewriteAfterHashCall?: number
  rewriteBytes?: string
  rewriteQuarantineAfterSessionLink?: boolean
  rewriteQuarantineBeforeRecovery?: boolean
  rewriteSourceAfterSessionLink?: boolean
  rewriteTargetAfterSessionLink?: boolean
  rewriteTarget?: 'source-auth' | 'source-credentials' | 'target-auth'
  sourceAuthSymlink?: boolean
  sourceSession?: string
  sourceCredentials?: string
}

export type DrainApplyOutcome = {
  legacyAuth: string | null
  markerExists: boolean
  status: number
  targetAuth: string
  targetCredentials: string | null
  targetMode: number
  targetSession: string | null
  sourceQuarantineAuth: string | null
  sourceRecoveryAuth: string | null
  destinationRecoveryAuth: string | null
  destinationRecoveryPathExists: boolean
  sessionCommitMarkerExists: boolean
}
