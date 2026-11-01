import type { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogReadParams } from './agent-model-catalog-service-contract'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

export const AGENT_MODEL_CATALOG_PICKER_WAIT_MS = 30_000

/** Follow a fingerprint until success, exhaustion or a fixed deadline. */
export class AgentModelCatalogListingWaiters {
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly read: (fingerprint: string) => AgentModelCatalogEntry | null,
    private readonly listing: (fingerprint: string) => boolean
  ) {}

  wait(
    fingerprint: string,
    waitForChange = false,
    terminal = false
  ): Promise<AgentModelCatalogEntry | null> | null {
    if (!this.listing(fingerprint)) {
      return null
    }
    const previous = this.read(fingerprint)
    return new Promise((resolve) => {
      const waiters = this.waiters.get(fingerprint) ?? new Set<() => void>()
      let settled = false
      const finish = (entry: AgentModelCatalogEntry | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(deadline)
        waiters.delete(check)
        if (waiters.size === 0) {
          this.waiters.delete(fingerprint)
        }
        resolve(entry)
      }
      const check = (): void => {
        const entry = this.read(fingerprint)
        if (
          (!terminal && entry && (!waitForChange || entry !== previous)) ||
          !this.listing(fingerprint)
        ) {
          finish(entry)
        }
      }
      const deadline = terminal
        ? undefined
        : setTimeout(() => finish(this.read(fingerprint)), AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
      waiters.add(check)
      this.waiters.set(fingerprint, waiters)
      check()
    })
  }

  notify(fingerprint: string): void {
    for (const check of this.waiters.get(fingerprint) ?? []) {
      check()
    }
  }
}

/** Compatibility discovery waits share the deadline captured before any scope resolution. */
export async function waitForAgentModelCatalogRead(input: {
  params: AgentModelCatalogReadParams & { deadline: number }
  store: AgentModelCatalogStore
  resolve: (params: AgentModelCatalogReadParams) => Promise<void>
  claim: () => { ready: Promise<void>; promise: Promise<void> } | undefined
  binding: () => AgentModelCatalogBinding | undefined
}): Promise<void> {
  const { params, store } = input
  const wait = async (): Promise<void> => {
    void input.resolve(params)
    await input.claim()?.ready
    const bound = input.binding()
    await bound?.projecting
    if (Date.now() >= params.deadline) {
      return
    }
    if (
      bound &&
      (!store.get(bound.fingerprint) ||
        independentAgentModelCatalog(params.agent) ||
        store.heldReasonDue(bound.fingerprint))
    ) {
      await store.pendingListing(bound.fingerprint, true, params.legacy)
    }
    if (bound && !store.isListing(bound.fingerprint)) {
      await input.claim()?.promise
    }
  }
  const remaining = params.deadline - Date.now()
  if (remaining > 0) {
    await withTimeout(wait(), remaining, undefined)
  }
}

/** The operation owns its original budget even while a resolver cannot be cancelled. */
export function runAgentModelCatalogOperation(
  run: () => Promise<void>,
  remaining: number,
  controller: AbortController,
  finished: () => void
): Promise<void> {
  let settled = false
  const operation = Promise.resolve()
    .then(run)
    .catch(() => {})
    .finally(() => {
      settled = true
    })
  return withTimeout(operation, remaining, undefined).finally(() => {
    if (!settled) {
      controller.abort()
    }
    finished()
  })
}
