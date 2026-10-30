import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'

// Only probes establish chat unavailability; live listings cannot replace that verdict.

export const AGENT_MODEL_CATALOG_FAILURE_TTL_MS = 30_000

/** Cancelled or folderless probes establish nothing about account health and are not cached. */
export class AgentModelCatalogListingStoppedError extends Error {}

export type AgentModelCatalogFailure = {
  /** Hash keys omit the agent name; retain it for agent-wide expiration. */
  agent?: string
  detail: string
  failedAt: number
  unavailable?: AgentSessionUnavailable
}

export class AgentModelCatalogFailures {
  private readonly failures = new Map<string, AgentModelCatalogFailure>()

  constructor(private readonly now: () => number) {}

  get(fingerprint: string): AgentModelCatalogFailure | null {
    return this.failures.get(fingerprint) ?? null
  }

  /** Inside its TTL. An expired reason stays readable until the next probe replaces it, so a read
   *  can still serve it while the probe that re-derives it runs; an expired plain failure dies. */
  detail(fingerprint: string): string | null {
    return this.isActive(fingerprint) ? (this.get(fingerprint)?.detail ?? null) : null
  }

  unavailableDue(fingerprint: string): boolean {
    return this.get(fingerprint)?.unavailable !== undefined && !this.isActive(fingerprint)
  }

  isActive(fingerprint: string): boolean {
    const failure = this.failures.get(fingerprint)
    if (!failure) {
      return false
    }
    if (this.now() - failure.failedAt < AGENT_MODEL_CATALOG_FAILURE_TTL_MS) {
      return true
    }
    if (!failure.unavailable) {
      this.failures.delete(fingerprint)
    }
    return false
  }

  expireAgent(agent: string): void {
    for (const [fingerprint, failure] of this.failures) {
      if (failure.agent === agent) {
        this.expire(fingerprint)
      }
    }
  }

  /** Reprobe held unavailability on next read; discard ordinary failures. */
  expire(fingerprint: string): void {
    const failure = this.failures.get(fingerprint)
    if (failure?.unavailable) {
      failure.failedAt = this.now() - AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    } else {
      this.failures.delete(fingerprint)
    }
  }

  /** Only probes replace chat-unavailability verdicts; successful live listings cannot clear them. */
  listed(
    fingerprint: string,
    agent: string,
    origin: 'live-session' | 'probe',
    unavailable: AgentSessionUnavailable | undefined
  ): void {
    if (origin !== 'probe' && this.failures.get(fingerprint)?.unavailable) {
      return
    }
    this.failures.delete(fingerprint)
    if (origin === 'probe' && unavailable) {
      this.probeFailed(fingerprint, agent, new AgentModelCatalogUnavailableError(unavailable))
    }
  }

  /** Failed probes replace prior verdicts without inventing unavailability reasons. */
  probeFailed(fingerprint: string, agent: string, error: unknown): void {
    this.failures.set(fingerprint, {
      agent,
      detail: error instanceof Error ? error.message : String(error),
      failedAt: this.now(),
      ...(error instanceof AgentModelCatalogUnavailableError
        ? { unavailable: error.unavailable }
        : {})
    })
  }
}
