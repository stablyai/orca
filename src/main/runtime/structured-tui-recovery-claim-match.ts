export type StructuredTuiRecoveryClaimMismatch =
  | 'claim'
  | 'connected'
  | 'owner-phase'
  | 'owner-pty-id'
  | 'persisted-incarnation'
  | 'persisted-pty-id'
  | 'persisted-session'
  | 'persisted-tab'
  | 'presented-incarnation'
  | 'pty-workspace'
  | 'surface-workspace'

export type StructuredTuiRecoveryClaimCandidate = {
  expectedWorkspaceId: string
  claimMatches: boolean
  pty: {
    connected: boolean
    ptyId: string
    incarnationId: string | null
    worktreeId: string
  }
  owner: {
    phase: string
    ptyId: string
    surface: {
      worktreeId: string
      tabId: string
      leafId: string
    }
  }
  persisted: {
    sessionResolved: boolean
    tabPresent: boolean
    ptyId: string | null
    incarnationId: string | null
  }
}

export type StructuredTuiRecoveryClaimEvaluation = {
  matches: boolean
  mismatchedFields: StructuredTuiRecoveryClaimMismatch[]
}

export function evaluateStructuredTuiRecoveryClaim(
  candidate: StructuredTuiRecoveryClaimCandidate,
  worktreeIdsEqual: (left: string, right: string) => boolean = (left, right) => left === right
): StructuredTuiRecoveryClaimEvaluation {
  const mismatchedFields: StructuredTuiRecoveryClaimMismatch[] = []
  if (!candidate.pty.connected) {
    mismatchedFields.push('connected')
  }
  if (candidate.owner.phase !== 'live') {
    mismatchedFields.push('owner-phase')
  }
  if (candidate.owner.ptyId !== candidate.pty.ptyId) {
    mismatchedFields.push('owner-pty-id')
  }
  if (!candidate.pty.incarnationId) {
    mismatchedFields.push('presented-incarnation')
  }
  if (!worktreeIdsEqual(candidate.pty.worktreeId, candidate.expectedWorkspaceId)) {
    mismatchedFields.push('pty-workspace')
  }
  if (!worktreeIdsEqual(candidate.owner.surface.worktreeId, candidate.expectedWorkspaceId)) {
    mismatchedFields.push('surface-workspace')
  }
  if (!candidate.claimMatches) {
    mismatchedFields.push('claim')
  }
  if (!candidate.persisted.sessionResolved) {
    mismatchedFields.push('persisted-session')
  } else {
    if (!candidate.persisted.tabPresent) {
      mismatchedFields.push('persisted-tab')
    }
    if (candidate.persisted.ptyId !== candidate.owner.ptyId) {
      mismatchedFields.push('persisted-pty-id')
    }
    // Packaged hydration can omit this binding briefly; daemon incarnation and child proof stay mandatory.
    if (
      candidate.persisted.incarnationId !== null &&
      candidate.persisted.incarnationId !== candidate.pty.incarnationId
    ) {
      mismatchedFields.push('persisted-incarnation')
    }
  }
  return { matches: mismatchedFields.length === 0, mismatchedFields }
}
