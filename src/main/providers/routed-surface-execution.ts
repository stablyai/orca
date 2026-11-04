import type { SurfaceExecutorIdentity } from '../../shared/workspace-surfaces/surface-execution-provenance'
import {
  surfaceExecutorKey,
  type SurfaceExecutorAdmission,
  type SurfaceExecutorCandidate,
  type SurfaceExecutorDecision,
  type SurfaceExecutorResult
} from '../../shared/workspace-surfaces/surface-executor-contract'
import type { IPtyProvider } from './pty-provider-contract'

/** Routing caches observations; only the canonical allocation elects a physical executor. */
export class RoutedSurfaceExecution<Provider extends IPtyProvider = IPtyProvider> {
  private readonly routes = new Map<string, Provider>()
  constructor(
    private readonly providers: () => readonly Provider[],
    private readonly select: (candidate: SurfaceExecutorCandidate) => Promise<Provider>
  ) {}

  retainRecoveryInterest(): () => void {
    const releases = this.providers().flatMap((provider) => {
      const release = provider.surfaceExecution?.retainRecoveryInterest?.()
      return release ? [release] : []
    })
    return () => {
      for (const release of releases) {
        release()
      }
    }
  }

  onWake(listener: (admission?: SurfaceExecutorAdmission) => void): () => void {
    const disposers = this.providers().flatMap((provider) => {
      const dispose = provider.surfaceExecution?.onWake?.(listener)
      return dispose ? [dispose] : []
    })
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }

  async identify(candidate: SurfaceExecutorCandidate): Promise<SurfaceExecutorIdentity | null> {
    const provider = await this.select(candidate)
    const identity = await provider.surfaceExecution?.identify(candidate)
    if (!identity) {
      return null
    }
    this.routes.set(this.key({ ...candidate, ...identity }), provider)
    return identity
  }

  async provider(admission: SurfaceExecutorAdmission): Promise<Provider | null> {
    const existing = this.routes.get(this.key(admission))
    if (existing) {
      return existing
    }
    for (const provider of this.providers()) {
      const result = await provider.surfaceExecution?.query(admission)
      if (result?.executorId === admission.executorId) {
        this.routes.set(this.key(admission), provider)
        return provider
      }
    }
    return null
  }

  async query(admission: SurfaceExecutorAdmission): Promise<SurfaceExecutorResult> {
    return (
      (await this.provider(admission))?.surfaceExecution?.query(admission) ??
      this.unknown(admission)
    )
  }

  async settle(decision: SurfaceExecutorDecision): Promise<SurfaceExecutorResult> {
    return (
      (await this.provider(decision.admission))?.surfaceExecution?.settle(decision) ??
      this.unknown(decision.admission)
    )
  }

  async release(admission: SurfaceExecutorAdmission): Promise<void> {
    await (await this.provider(admission))?.surfaceExecution?.release(admission)
    this.routes.delete(this.key(admission))
  }

  private key(admission: SurfaceExecutorAdmission): string {
    return `${surfaceExecutorKey(admission)}:${admission.executorId}`
  }
  private unknown(admission: SurfaceExecutorAdmission): SurfaceExecutorResult {
    return { executorId: 'unavailable', admission, state: { kind: 'unverifiable' } }
  }
}
