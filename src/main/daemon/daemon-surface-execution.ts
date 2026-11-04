import {
  surfaceExecutorIdentitySchema,
  type SurfaceExecutorIdentity
} from '../../shared/workspace-surfaces/surface-execution-provenance'
import { isDeepStrictEqual } from 'node:util'
import {
  surfaceExecutorResultSchema,
  type SurfaceExecutorAdmission,
  type SurfaceExecutorCandidate,
  type SurfaceExecutorDecision,
  type SurfaceExecutorResult
} from '../../shared/workspace-surfaces/surface-executor-contract'
import { SURFACE_EXECUTION_PROTOCOL_VERSION } from './daemon-protocol-version'
import type { SurfaceExecutionRequest } from './types'

export class DaemonSurfaceExecution {
  constructor(
    private readonly transport: {
      retainRecoveryInterest?: () => () => void
      version: () => number
      ready: () => Promise<void>
      onWake: (listener: (admission?: SurfaceExecutorAdmission) => void) => () => void
      request: (payload: SurfaceExecutionRequest['payload']) => Promise<unknown>
    }
  ) {}

  retainRecoveryInterest(): () => void {
    return this.transport.retainRecoveryInterest?.() ?? (() => {})
  }

  onWake(listener: (admission?: SurfaceExecutorAdmission) => void): () => void {
    return this.transport.onWake(listener)
  }

  async identify(candidate: SurfaceExecutorCandidate): Promise<SurfaceExecutorIdentity | null> {
    if (this.transport.version() < SURFACE_EXECUTION_PROTOCOL_VERSION) {
      return null
    }
    await this.transport.ready()
    const result = await this.transport.request({ operation: 'identify', candidate })
    const identity = surfaceExecutorIdentitySchema.safeParse(result)
    if (!identity.success) {
      throw new Error('terminal_executor_unavailable')
    }
    return identity.data
  }

  query(admission: SurfaceExecutorAdmission): Promise<SurfaceExecutorResult> {
    return this.call(admission, { operation: 'query', admission })
  }

  settle(decision: SurfaceExecutorDecision): Promise<SurfaceExecutorResult> {
    return this.call(decision.admission, { operation: 'settle', decision })
  }

  async release(admission: SurfaceExecutorAdmission): Promise<void> {
    if (this.transport.version() < SURFACE_EXECUTION_PROTOCOL_VERSION) {
      return
    }
    await this.transport.ready()
    await this.transport.request({ operation: 'release', admission })
  }

  private async call(
    admission: SurfaceExecutorAdmission,
    payload: SurfaceExecutionRequest['payload']
  ): Promise<SurfaceExecutorResult> {
    try {
      if (this.transport.version() >= SURFACE_EXECUTION_PROTOCOL_VERSION) {
        await this.transport.ready()
        const result = surfaceExecutorResultSchema.safeParse(await this.transport.request(payload))
        if (result.success && isDeepStrictEqual(result.data.admission, admission)) {
          return result.data
        }
      }
    } catch {}
    return { executorId: 'unavailable', admission, state: { kind: 'unverifiable' } }
  }
}
