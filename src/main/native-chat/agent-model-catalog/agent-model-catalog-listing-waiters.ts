import type { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogReadParams } from './agent-model-catalog-service-contract'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../shared/agent-session/options/agent-model-catalog-ownership'
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
  /** Starts this read's own claim; the read waits on that claim, not another reader's. */
  resolve: (
    params: AgentModelCatalogReadParams
  ) => { ready: Promise<void>; promise: Promise<void>; projecting?: Promise<void> } | undefined
  binding: () => AgentModelCatalogBinding | undefined
}): Promise<void> {
  const { params, store } = input
  const wait = async (): Promise<void> => {
    const claim = input.resolve(params)
    await claim?.ready
    const bound = input.binding()
    await (claim?.projecting ?? bound?.projecting)
    if (Date.now() >= params.deadline) {
      return
    }
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
      await claim?.promise
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
