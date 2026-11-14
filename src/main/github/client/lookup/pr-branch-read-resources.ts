import type { CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { readTimedPROutcome } from './pr-last-outcome'

export type PRBranchReadResult = {
  outcome: PRRefreshOutcome
  sequence: number
  current: () => boolean
}

type PRBranchReadResource = {
  probes: CoalescedProbes<PRBranchReadResult>
  running: number
  latestStart: number
}

const resources = new Map<string, PRBranchReadResource>()

export function prBranchReadResource(key: string): PRBranchReadResource {
  let resource = resources.get(key)
  if (!resource) {
    resource = { probes: new Map(), running: 0, latestStart: 0 }
    resources.set(key, resource)
  }
  return resource
}

export function pendingPRBranchRead(
  key: string,
  intent: 'fresh' | 'timed'
): Promise<PRBranchReadResult> | null {
  const pending = resources.get(key)?.probes.get(intent)
  return pending && Date.now() - pending.startedAt < 2 * 60_000 ? pending.promise : null
}

export function retirePRBranchReadResource(key: string, resource: PRBranchReadResource): void {
  if (resource.probes.size === 0 && resource.running === 0 && resources.get(key) === resource) {
    resources.delete(key)
  }
}

export function startPRBranchRead(
  key: string,
  resource: PRBranchReadResource,
  sequence: number
): { current: () => boolean; finish: () => void } {
  resource.running += 1
  resource.latestStart = sequence
  return {
    current: () =>
      Math.max(resource.latestStart, resources.get(key)?.latestStart ?? 0) === sequence,
    finish: () => {
      resource.running -= 1
      retirePRBranchReadResource(key, resource)
    }
  }
}

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

export type PRReadSettlement = (
  outcome: PRRefreshOutcome,
  producer: { retained: boolean }
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
  readRetained: (settle?: PRReadSettlement) => Promise<PRRefreshOutcome | null>
  canRetain: () => boolean
  scheduleError: (expected: PRRefreshOutcome, outcome: PRRefreshOutcome) => void
  readResult: (
    settle?: PRReadSettlement,
    requireRetention?: boolean
  ) => Promise<PRBranchReadResult | null>
  pending: () => Promise<PRBranchReadResult> | null
  withExecution: <T>(operation: () => Promise<T>) => Promise<T>
  read: (settle?: PRReadSettlement) => Promise<PRRefreshOutcome>
}
