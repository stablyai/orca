import type { CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

/**
 * One exact PR read (scope, branch, links, options) and what reads it: its coalesced timed and
 * fresh probes, the provider reads running for it (including ones a fresh read replaced), the
 * start of the newest one, and failures a retry still owes. It lives until none of those remain.
 */
export type PRBranchReadResource = {
  probes: CoalescedProbes<PRRefreshOutcome>
  running: number
  latestStart: number
  failures: number
}

/** A failed provider read's claim on its resource while a retry owes it: current until a newer
 *  provider read of the same resource starts, or its scope changes. Released exactly once. */
export type PRReadFailureHold = { current: () => boolean; release: () => void }

const resources = new Map<string, PRBranchReadResource>()

export function prBranchReadResource(key: string): PRBranchReadResource {
  let resource = resources.get(key)
  if (!resource) {
    resource = { probes: new Map(), running: 0, latestStart: 0, failures: 0 }
    resources.set(key, resource)
  }
  return resource
}

/** A probe still running for the resource, joinable while younger than two minutes. */
export function pendingPRBranchRead(
  key: string,
  intent: 'fresh' | 'timed'
): Promise<PRRefreshOutcome> | null {
  const pending = resources.get(key)?.probes.get(intent)
  return pending && Date.now() - pending.startedAt < 2 * 60_000 ? pending.promise : null
}

/** Drops the resource once no probe, provider read or owed retry refers to it. */
export function retirePRBranchReadResource(key: string, resource: PRBranchReadResource): void {
  if (
    resource.probes.size === 0 &&
    resource.running === 0 &&
    resource.failures === 0 &&
    resources.get(key) === resource
  ) {
    resources.delete(key)
  }
}

/** Marks an actual provider read of the resource as started; returns its end. */
export function startPRBranchRead(
  key: string,
  resource: PRBranchReadResource,
  sequence: number
): () => void {
  resource.running += 1
  resource.latestStart = Math.max(resource.latestStart, sequence)
  return () => {
    resource.running -= 1
    retirePRBranchReadResource(key, resource)
  }
}

export function holdPRBranchReadFailure(
  key: string,
  resource: PRBranchReadResource,
  sequence: number,
  inScope: () => boolean
): PRReadFailureHold {
  resource.failures += 1
  let held = true
  return {
    current: () => held && resource.latestStart === sequence && inScope(),
    release: () => {
      if (held) {
        held = false
        resource.failures -= 1
        retirePRBranchReadResource(key, resource)
      }
    }
  }
}

export function _prBranchReadResourceCountForTests(): number {
  return resources.size
}
