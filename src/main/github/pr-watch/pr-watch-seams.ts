// The host entry points other features build on. They outlive the chat host's install, so callers
// may register and subscribe before it starts or across its restarts. None of them wakes an agent.

import { cancelPRWatchRead, schedulePRWatchRead } from '../pr-refresh-coordinator'
import { prWatchQueueKey, type PRWatchJob } from '../pr-refresh-watch-jobs'
import {
  prWatchCandidate,
  type PRChatActionRecord,
  type PRObservation,
  type PRWatchHandle,
  type PRWatchRegistration,
  type PRWatchServiceDeps
} from './pr-watch-types'

export type PRWatchSeamSource = {
  resolveRepo: PRWatchServiceDeps['resolveRepo']
  pullRequestActionsFor: (prKey: string) => PRChatActionRecord[]
  ownerChatFor: (prKey: string) => string | null
}

type FollowUp = { job: PRWatchJob; registration: PRWatchRegistration; count: number }

const followUps = new Map<string, FollowUp>()
const observers = new Set<(observation: PRObservation) => void>()
let source: PRWatchSeamSource | null = null

function scheduleFollowUp(entry: FollowUp, from: PRWatchSeamSource): void {
  const { job, registration } = entry
  void from.resolveRepo(registration.repoId, registration.connectionId ?? null).then((repo) => {
    if (repo && source === from && followUps.get(prWatchQueueKey(job)) === entry) {
      const workspace = { ...repo, checkoutPath: repo.repoPath, branch: registration.branch }
      schedulePRWatchRead(job, prWatchCandidate(workspace, registration.prNumber), Date.now())
    }
  })
}

export function attachPRWatchSource(next: PRWatchSeamSource): () => void {
  source = next
  for (const entry of followUps.values()) {
    scheduleFollowUp(entry, next)
  }
  return () => {
    if (source === next) {
      source = null
      for (const { job } of followUps.values()) {
        cancelPRWatchRead(job)
      }
    }
  }
}

export function isPRFollowUpJob(job: PRWatchJob): boolean {
  return followUps.has(prWatchQueueKey(job))
}

/** Keeps reading a PR for a reason other than a chat's lines, through the same budgeted queue. */
export function registerPRWatch(registration: PRWatchRegistration): PRWatchHandle {
  const target = registration.prNumber ?? `branch:${registration.branch}`
  const scope = `${registration.connectionId ?? 'local'}:${registration.repoId}`
  const job = { prKey: `${registration.reason}:${scope}:${target}` }
  const key = prWatchQueueKey(job)
  const entry = followUps.get(key) ?? { job, registration, count: 0 }
  entry.count += 1
  if (entry.count === 1) {
    followUps.set(key, entry)
    if (source) {
      scheduleFollowUp(entry, source)
    }
  }
  let registered = true
  return {
    unregister: () => {
      if (!registered) {
        return
      }
      registered = false
      entry.count -= 1
      if (entry.count === 0 && followUps.get(key) === entry) {
        followUps.delete(key)
        cancelPRWatchRead(job)
      }
    }
  }
}

/** Complete reads of PRs' current heads; earlier-head reads never arrive here. */
export function subscribePRObservations(
  callback: (observation: PRObservation) => void
): () => void {
  const registered = (observation: PRObservation) => callback(observation)
  observers.add(registered)
  return () => observers.delete(registered)
}

export function publishPRObservation(
  observation: PRObservation,
  onError: (error: unknown) => void
): void {
  for (const observer of observers) {
    try {
      observer(observation)
    } catch (error) {
      onError(error)
    }
  }
}

export function pullRequestActionsFor(prKey: string): PRChatActionRecord[] {
  return source?.pullRequestActionsFor(prKey) ?? []
}

/** The newest verified pusher, else the opener, else none. */
export function ownerChatFor(prKey: string): string | null {
  return source?.ownerChatFor(prKey) ?? null
}
