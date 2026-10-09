import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'

// A catalog's failed listings, held under a short TTL so a burst of picker opens does not hammer a
// dead binary. A probe failure may also say why no chat can start under the account (not signed
// in, no CLI); only a later probe answers that again, so a chat's own listing never replaces it.

export const AGENT_MODEL_CATALOG_FAILURE_TTL_MS = 30_000

export type AgentModelCatalogFailure = {
  /** Set by the store's own refreshes; the fingerprint is a hash, so expiry by agent reads it. */
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

  /** The account behind this agent's catalogs changed: every held failure is due for a re-probe. */
  expireAgent(agent: string): void {
    for (const [fingerprint, failure] of this.failures) {
      if (failure.agent === agent) {
        this.expire(fingerprint)
      }
    }
  }

  /** Something showed the answer may be stale (a chat started under this account): a held reason
   *  is due for the probe on the next read, and a plain failure is dropped. */
  expire(fingerprint: string): void {
    const failure = this.failures.get(fingerprint)
    if (failure?.unavailable) {
      failure.failedAt = this.now() - AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    } else {
      this.failures.delete(fingerprint)
    }
  }

  /** A listing succeeded. Only the probe answers whether the account can start a chat, so only it
   *  replaces that answer, with the reason it found beside its list, if any. */
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

  /** A chat's own listing failed. That says nothing about sign-in or the CLI, so a reason the
   *  probe found stands. */
  chatFailed(fingerprint: string, detail: string, agent?: string): void {
    if (this.failures.get(fingerprint)?.unavailable) {
      return
    }
    this.failures.set(fingerprint, { ...(agent ? { agent } : {}), detail, failedAt: this.now() })
  }

  /** Any probe answer replaces the last, so a probe that keeps timing out holds no reason. */
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
