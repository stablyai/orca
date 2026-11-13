import type { CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { readTimedPROutcome } from './pr-last-outcome'

/**
 * One exact PR read (scope, branch, links, options) and what reads it: its coalesced timed and
 * fresh probes, the provider reads running for it (including ones a fresh read replaced), the
 * start of the newest one, and failures a retry still owes, each with what a newer start retires.
 * It lives until none of those remain.
 */
export type PRBranchReadResource = {
  probes: CoalescedProbes<PRBranchReadResult>
  running: number
  latestStart: number
  failures: Set<() => void>
}

export type PRReadSettlement = (
  outcome: PRRefreshOutcome,
  producer: PRBranchReadProducer
) => PRRefreshOutcome

export type PreparedPRBranchRead = {
  key: string
  reprepare: () => Promise<PreparedPRBranchRead>
  cached: () => ReturnType<typeof readTimedPROutcome>
  isCurrent: () => boolean
  accepts: (outcome: PRRefreshOutcome) => boolean
  didRead: () => boolean
  release: () => void
  hold: () => () => void
  /** The read's shared result; null only when it had to keep its result and found no room. */
  readResult: (
    settle?: PRReadSettlement,
    requireRetention?: boolean
  ) => Promise<PRBranchReadResult | null>
  canRetain: () => boolean
  scheduleError: (expected: PRRefreshOutcome, outcome: PRRefreshOutcome) => void
  pending: () => Promise<PRBranchReadResult> | null
  withExecution: <T>(operation: () => Promise<T>) => Promise<T>
  /** The read's own outcome, for callers that reply with it as it is. */
  read: (settle?: PRReadSettlement) => Promise<PRRefreshOutcome>
}

/** What a provider read finished with, shared by everything that joined it: its outcome (settled
 *  once, by the read itself), its start and whether it is still the newest read of its request in
 *  scope. Each consumer decides what it may publish from this, not from whether it settled. */
export type PRBranchReadResult = {
  outcome: PRRefreshOutcome
  sequence: number
  current: () => boolean
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
): Promise<PRBranchReadResult> | null {
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

/** No provider read of the request started after this one, even once its resource was retired and
 *  a new one created for later reads. */
function newestPRBranchRead(
  key: string,
  resource: PRBranchReadResource,
  sequence: number
): boolean {
  return Math.max(resource.latestStart, resources.get(key)?.latestStart ?? 0) <= sequence
}

/** What a consumer of a finished read may publish as its request's current state: the read's own
 *  outcome while it is still the newest read in scope; otherwise a newer read's accepted exact
 *  result once one finished, or nothing while that read runs or kept no result. */
export function deliverablePRBranchOutcome(
  prepared: Pick<PreparedPRBranchRead, 'isCurrent' | 'cached'>,
  result: PRBranchReadResult
): PRRefreshOutcome | null {
  if (result.current()) {
    return result.outcome
  }
  const cached = prepared.isCurrent() ? prepared.cached() : null
  return cached && cached.sequence > result.sequence ? cached.outcome : null
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
    current: () => newestPRBranchRead(key, resource, sequence) && inScope()
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
    current: () =>
      resource.failures.has(notice) && newestPRBranchRead(key, resource, sequence) && inScope(),
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
