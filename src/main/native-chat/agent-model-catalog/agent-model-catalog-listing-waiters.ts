import type { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogReadParams } from './agent-model-catalog-service-contract'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'
import type { AgentModelCatalogRefresh } from './agent-model-catalog-refresh'

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

/** A reader waits on shared work only until its own deadline or cancellation; it ends nothing. */
export function waitWithinAgentModelCatalogRead(
  reader: { deadline?: number; signal: AbortSignal },
  work: Promise<unknown> | undefined
): Promise<void> {
  const remaining = reader.deadline === undefined ? undefined : reader.deadline - Date.now()
  if (!work || reader.signal.aborted || (remaining !== undefined && remaining <= 0)) {
    return Promise.resolve()
  }
  const cancelled = Promise.withResolvers<void>()
  const cancel = (): void => cancelled.resolve()
  reader.signal.addEventListener('abort', cancel, { once: true })
  const waited = Promise.race([work.then(noop, noop), cancelled.promise])
  return (remaining === undefined ? waited : withTimeout(waited, remaining, undefined)).finally(
    () => reader.signal.removeEventListener('abort', cancel)
  )
}

const noop = (): void => {}

/** A waiting read follows the refresh it joined, then the listing its scope names. */
export async function waitForAgentModelCatalogRead(input: {
  params: AgentModelCatalogReadParams
  reader: { deadline: number; signal: AbortSignal }
  store: AgentModelCatalogStore
  refresh: AgentModelCatalogRefresh | undefined
  binding: () => AgentModelCatalogBinding | undefined
}): Promise<void> {
  const { params, store, refresh } = input
  const wait = async (): Promise<void> => {
    await refresh?.listing
    await (refresh?.defaults ?? input.binding()?.projecting)
    const bound = input.binding()
    if (
      bound &&
      (!store.get(bound.fingerprint) ||
        independentAgentModelCatalog(params.agent) ||
        (usesModelSpecificAcpEfforts(params.agent) && store.isListing(bound.fingerprint)) ||
        store.heldReasonDue(bound.fingerprint))
    ) {
      await store.pendingListing(
        bound.fingerprint,
        true,
        params.legacy || usesModelSpecificAcpEfforts(params.agent)
      )
    }
    if (bound && !store.isListing(bound.fingerprint)) {
      await refresh?.done
    }
  }
  await waitWithinAgentModelCatalogRead(input.reader, wait())
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
  // Cancelling the operation ends its wait at once, whatever its resolver is still doing.
  const cancelled = Promise.withResolvers<void>()
  const cancel = (): void => cancelled.resolve()
  controller.signal.addEventListener('abort', cancel, { once: true })
  return withTimeout(Promise.race([operation, cancelled.promise]), remaining, undefined).finally(
    () => {
      controller.signal.removeEventListener('abort', cancel)
      if (!settled) {
        controller.abort()
      }
      finished()
    }
  )
}
