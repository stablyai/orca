import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

import { waitForPromiseWithSignal, throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import type { SessionSearchScanRoots } from './session-search-service'

type Refresh = { controller: AbortController; promise: Promise<void>; users: number }

/** Share concurrent query refreshes, never completed filesystem snapshots. */
export class SessionSearchRefreshLane {
  private readonly runs = new Map<string, Refresh>()
  private readonly outstanding = new Set<Refresh>()

  async run(
    roots: SessionSearchScanRoots,
    refresh: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfSignalAborted(signal)
    const key = stableInFlightKey(Object.entries(roots).sort(([a], [b]) => a.localeCompare(b)))
    let run = this.runs.get(key)
    if (!run) {
      const controller = new AbortController()
      run = { controller, users: 0, promise: Promise.resolve() }
      const current = run
      run.promise = Promise.resolve()
        .then(() => {
          throwIfSignalAborted(controller.signal)
          return refresh(controller.signal)
        })
        .finally(() => {
          this.outstanding.delete(current)
          if (this.runs.get(key) === current) {
            this.runs.delete(key)
          }
        })
      this.runs.set(key, run)
      this.outstanding.add(run)
    }
    run.users++
    try {
      await waitForPromiseWithSignal(run.promise, signal)
    } finally {
      run.users--
      if (run.users === 0) {
        run.controller.abort()
        if (this.runs.get(key) === run) {
          this.runs.delete(key)
        }
      }
    }
  }

  cancel(): void {
    for (const run of this.runs.values()) {
      run.controller.abort()
    }
    this.runs.clear()
  }

  async drain(): Promise<void> {
    const pending = [...this.outstanding].map((run) => run.promise)
    this.cancel()
    await Promise.allSettled(pending)
  }
}

export async function discoverRecentSearchFiles(
  roots: SessionSearchScanRoots,
  signal?: AbortSignal
): Promise<SessionFileCandidate[]> {
  const options = { ...roots, signal }
  const discoveries = await discoverAiVaultSessionSources({
    options,
    limitPerAgent: 12,
    issues: []
  })
  return sessionCandidatesFromDiscoveries(discoveries, options)
}
