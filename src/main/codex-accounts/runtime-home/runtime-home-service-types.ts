import type { CodexManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import type { CodexSettingsPromotionHomes } from '../../codex/configuration/settings/config-settings-promotion'
import type { UsageReadingAccount } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export type CodexHomeLaunchOptions = {
  unavailableManagedHomePath?: string
  /** Hands the launch the config mirror it owes, as data, so it can run on the Codex trust worker. */
  deferConfigSync?: (homes: CodexSettingsPromotionHomes) => void
}

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

/** A ready null home means no mirror; unavailable means its state could not be read. */
export type CodexMirroredHomeStatus =
  | { kind: 'ready'; homePath: string | null }
  | { kind: 'unavailable' }

/** Result used by quota polling, where `skip` means no process should be spawned. */
export type CodexRateLimitHomeResolution =
  /** `readingAccount`: whose own home this is (null id: System default); absent when the shared mirror may hold a saved account's login. */
  | { kind: 'ready'; codexHomePath: string | null; readingAccount?: UsageReadingAccount }
  | { kind: 'skip' }
