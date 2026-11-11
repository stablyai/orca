import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isOrcaCloudRuntimeInAccount } from '../../shared/hosted-sandbox/orca-cloud-account'

// The Orca Cloud account (team) this desktop acts for right now, in sandbox-control's form. Set by
// the hosted-sandbox install; builds without Orca Cloud have no resolver and no cloud records.
let resolver: (() => string | null) | null = null

export function setOrcaCloudActiveAccountResolver(next: (() => string | null) | null): void {
  resolver = next
}

/** Null when signed out of Orca Cloud or when this build has no Orca Cloud. */
export function readOrcaCloudActiveAccountId(): string | null {
  try {
    return resolver?.() ?? null
  } catch {
    // An unreadable profile index is "no team", which hides cloud records rather than misfiling them.
    return null
  }
}

/**
 * Orca Cloud records in the given team; `undefined` (no team scoping wired) keeps them all, while
 * null (signed out) keeps none.
 */
export function listTeamCloudRuntimes(
  userDataPath: string,
  account: string | null | undefined
): EphemeralVmRuntimeRecord[] {
  return listEphemeralVmRuntimes(userDataPath).filter(
    (runtime) =>
      runtime.recipe?.provider === 'orca-cloud' &&
      (account === undefined || isOrcaCloudRuntimeInAccount(runtime, account))
  )
}
