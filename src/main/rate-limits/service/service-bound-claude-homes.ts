import { fetchBoundClaudeHomeUsage } from '../claude-bound-home-usage'
import { RateLimitServiceInactiveAccounts } from './service-inactive-accounts'
import { INACTIVE_FETCH_DEBOUNCE_MS } from './service-types'

export abstract class RateLimitServiceBoundClaudeHomes extends RateLimitServiceInactiveAccounts {
  /**
   * HTTP-only usage for each project group's bound CLAUDE_CONFIG_DIR, on the same expand trigger,
   * 60-second debounce and sequential loop as the inactive-account previews. Orca is read-only
   * toward a bound directory (D9), so a lapsed or missing token becomes a status, never a refresh.
   */
  async fetchBoundClaudeHomesOnOpen(): Promise<void> {
    if (Date.now() - this.lastBoundClaudeHomeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    this.pruneBoundClaudeHomeState()
    if (this.boundClaudeHomeFetching.size > 0) {
      return
    }
    const bindings = this.boundClaudeHomesResolver?.() ?? []
    if (bindings.length === 0) {
      return
    }
    const fetchGeneration = this.boundClaudeHomesGeneration
    const controller = this.beginFetchCycle()
    const signal = controller.signal

    for (const binding of bindings) {
      this.boundClaudeHomeFetching.add(binding.groupId)
    }
    this.pushToRenderer()

    try {
      for (const binding of bindings) {
        if (this.isStaleBoundClaudeHomeFetch(signal, fetchGeneration, binding)) {
          this.discardBoundClaudeHomeRow(binding)
          continue
        }
        try {
          const usage = await fetchBoundClaudeHomeUsage(binding.configDir, { signal })
          if (this.isStaleBoundClaudeHomeFetch(signal, fetchGeneration, binding)) {
            this.discardBoundClaudeHomeRow(binding)
            continue
          }
          this.boundClaudeHomeCache.set(binding.groupId, {
            configDir: binding.configDir,
            rateLimits: usage.rateLimits,
            status: usage.status,
            updatedAt: usage.rateLimits?.updatedAt ?? Date.now()
          })
        } catch {
          // Why: per-directory try/catch keeps one unreachable home or usage-endpoint error from
          // aborting the remaining bound groups in the batch. Drop the row only when it is already
          // stale — a transient 500 must not make a still-bound group vanish from the menu.
          if (this.isStaleBoundClaudeHomeFetch(signal, fetchGeneration, binding)) {
            this.boundClaudeHomeCache.delete(binding.groupId)
          } else if (!this.boundClaudeHomeCache.has(binding.groupId)) {
            // Why only with no prior row: a binding that has never fetched successfully renders
            // nothing at all, which reads as "the binding did not save". A prior row keeps its
            // last-known bars instead of being downgraded to a status line.
            this.boundClaudeHomeCache.set(binding.groupId, {
              configDir: binding.configDir,
              rateLimits: null,
              status: 'unavailable',
              updatedAt: Date.now()
            })
          }
        }
        this.boundClaudeHomeFetching.delete(binding.groupId)
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.boundClaudeHomesGeneration) {
        this.lastBoundClaudeHomeFetchAt = Date.now()
      }
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  /** Called when a group's binding changes or the group is deleted. */
  evictBoundClaudeHomeUsage(groupId: string): void {
    this.boundClaudeHomesGeneration += 1
    this.boundClaudeHomeCache.delete(groupId)
    this.boundClaudeHomeFetching.delete(groupId)
    // Why clear the debounce: the evicted group now has no row and no fetching flag, so it renders
    // as absent, not stale. A deliberate rebind outranks a rate-limiting window the user cannot see.
    this.lastBoundClaudeHomeFetchAt = 0
    this.pushToRenderer()
  }

  private isStaleBoundClaudeHomeFetch(
    signal: AbortSignal,
    fetchGeneration: number,
    binding: { groupId: string; configDir: string }
  ): boolean {
    return (
      signal.aborted ||
      fetchGeneration !== this.boundClaudeHomesGeneration ||
      !this.isCurrentBoundClaudeHome(binding)
    )
  }

  private discardBoundClaudeHomeRow(binding: { groupId: string; configDir: string }): void {
    this.boundClaudeHomeFetching.delete(binding.groupId)
    if (!this.isCurrentBoundClaudeHome(binding)) {
      this.boundClaudeHomeCache.delete(binding.groupId)
    }
    this.pushToRenderer()
  }

  protected isCurrentBoundClaudeHome(binding: { groupId: string; configDir: string }): boolean {
    return (this.boundClaudeHomesResolver?.() ?? []).some(
      (current) => current.groupId === binding.groupId && current.configDir === binding.configDir
    )
  }

  /** Drops rows whose group lost its binding, was deleted, or now points somewhere else. */
  protected pruneBoundClaudeHomeState(): void {
    const currentByGroupId = new Map(
      (this.boundClaudeHomesResolver?.() ?? []).map((binding) => [
        binding.groupId,
        binding.configDir
      ])
    )
    for (const [groupId, row] of this.boundClaudeHomeCache) {
      if (currentByGroupId.get(groupId) !== row.configDir) {
        this.boundClaudeHomeCache.delete(groupId)
      }
    }
    for (const groupId of this.boundClaudeHomeFetching) {
      if (!currentByGroupId.has(groupId)) {
        this.boundClaudeHomeFetching.delete(groupId)
      }
    }
  }
}
