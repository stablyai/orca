import type { CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PreparedPRBranchRead } from './pr-for-branch-outcome'

/**
 * One exact PR read (scope, branch, links, options) and what reads it: its coalesced timed and
 * fresh probes, the provider reads running for it (including ones a fresh read replaced), the
 * start of the newest one, and failures a retry still owes, each with what a newer start retires.
 * It lives until none of those remain.
 */
export type PRBranchReadResource = {
  probes: CoalescedProbes<PRRefreshOutcome>
  running: number
  latestStart: number
  failures: Set<() => void>
}

/** A failed provider read's claim on its resource while a retry owes it: current until a newer
 *  provider read of the same resource starts, or its scope changes. Released exactly once; a
 *  newer start runs its `onSuperseded` retirement while it is still kept. */
export type PRReadFailureHold = {
  current: () => boolean
  release: () => void
  onSuperseded: (retire: () => void) => void
}

/** `hold`: for a full read, claims this provider read's failure for a retry it owes, whether or not
 *  the exact cache kept the outcome. `current`: no newer provider read of the request has started
 *  and its scope is unchanged. */
export type PRBranchReadProducer = {
  retained: boolean
  hold?: () => PRReadFailureHold
  current?: () => boolean
}

/** A read that had to keep its outcome in the exact cache and found no room started nothing. */
export class PRLookupRetentionRefused extends Error {}

export function throwUnlessRetentionRefused(error: unknown): void {
  if (!(error instanceof PRLookupRetentionRefused)) {
    throw error
  }
}

/** What a refresh key is made of, for the read a caller made without its own settlement. */
export type PRBranchReadRequest = Pick<
  GitHubPRRefreshCandidate,
  'repoPath' | 'branch' | 'localGitOptions'
> &
  Partial<Pick<GitHubPRRefreshCandidate, 'connectionId' | 'linkedPRNumber'>>

export type PRBranchReadCompletion = (
  outcome: PRRefreshOutcome,
  producer: PRBranchReadProducer,
  prepared: PreparedPRBranchRead,
  request: PRBranchReadRequest
) => PRRefreshOutcome

let completion: PRBranchReadCompletion | null = null

/** The refresh owner settles full reads whose caller brought no settlement (another client's
 *  read, a provider lookup), so a visible row's next automatic work follows the newest read. */
export function setPRBranchReadCompletion(next: PRBranchReadCompletion | null): void {
  completion = next
}

export function completePRBranchRead(
  ...args: Parameters<PRBranchReadCompletion>
): PRRefreshOutcome {
  return completion ? completion(...args) : args[0]
}

const resources = new Map<string, PRBranchReadResource>()

export function prBranchReadResource(key: string): PRBranchReadResource {
  let resource = resources.get(key)
  if (!resource) {
    resource = { probes: new Map(), running: 0, latestStart: 0, failures: new Set() }
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
    resource.failures.size === 0 &&
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
  for (const retire of Array.from(resource.failures)) {
    retire()
  }
  return () => {
    resource.running -= 1
    retirePRBranchReadResource(key, resource)
  }
}

/** The settlement context of an actual provider read: whether the exact cache kept its outcome, a
 *  full read's failure claim, and whether it is still the newest read of its request in scope. */
export function prBranchReadProducer(
  key: string,
  resource: PRBranchReadResource,
  sequence: number,
  inScope: () => boolean,
  { retained, full }: { retained: boolean; full: boolean }
): PRBranchReadProducer {
  return {
    retained,
    hold: full ? () => holdPRBranchReadFailure(key, resource, sequence, inScope) : undefined,
    current: () => resource.latestStart === sequence && inScope()
  }
}

function holdPRBranchReadFailure(
  key: string,
  resource: PRBranchReadResource,
  sequence: number,
  inScope: () => boolean
): PRReadFailureHold {
  let retire = (): void => {}
  const notice = (): void => retire()
  resource.failures.add(notice)
  return {
    current: () => resource.failures.has(notice) && resource.latestStart === sequence && inScope(),
    release: () => {
      if (resource.failures.delete(notice)) {
        retirePRBranchReadResource(key, resource)
      }
    },
    onSuperseded: (next) => {
      retire = next
    }
  }
}

export function _prBranchReadResourceCountForTests(): number {
  return resources.size
}
