import type { CodexManagedAccount } from '../../shared/managed-account-types'

export type CodexSystemDefaultSnapshot = {
  authJson: string | null
}

export type CodexRuntimeLogoutMarker = {
  systemDefaultAuthJson: string | null
  loggedOutAt: number
}

export type CodexSharedRuntimeAuthProvenance =
  | { owner: 'system-default'; authJson: string | null }
  | {
      owner: 'managed'
      accountId: string
      systemDefaultBaseline?: { authJson: string | null }
    }

export type CodexSharedRuntimeAuthPendingProvenance = {
  owner: 'pending'
  next: CodexSharedRuntimeAuthProvenance
  runtimeAuthJson: string | null
}

export type CodexSharedRuntimeAuthProvenanceFile =
  | CodexSharedRuntimeAuthProvenance
  | CodexSharedRuntimeAuthPendingProvenance
  | { owner: 'fenced' }

export type CodexSharedRuntimeAuthProvenanceStatus =
  | { kind: 'missing' | 'fenced' }
  | { kind: 'committed'; provenance: CodexSharedRuntimeAuthProvenance }

export type CodexRuntimeLogoutMarkerStatus =
  | { kind: 'missing' }
  | { kind: 'applies' }
  | { kind: 'system-default-changed'; systemDefaultAuthJson: string | null }

export type CodexReadBackMatch =
  | {
      kind: 'matched'
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }
  | { kind: 'none' | 'ambiguous' }

export type CodexSelfContainedManagedHomeResolution =
  | { kind: 'owned'; homePath: string }
  | { kind: 'untrusted' }
  | { kind: 'indeterminate' }

/** Status used by the config-sync surface; `unavailable` is not a healthy null lane. */
export type CodexMirroredHomeStatus =
  | { kind: 'ready'; homePath: string | null }
  | { kind: 'unavailable' }

/** Result used by quota polling, where `skip` means no process should be spawned. */
export type CodexRateLimitHomeResolution =
  | { kind: 'ready'; codexHomePath: string | null }
  | { kind: 'skip' }
