import type { DeviceResumeConfirmed } from '@orca-cloud/relay-contract'
import { RelayStoreError, type RelayCredentialStore, type RelayIdentity } from './credential-store.js'

// Step 6: what a memory cell keeps instead of relay_connection_bases and relay_confirm_results.
// Both live and die with this process; a restart takes the splices with it.

export type MemoryConnectionBasis = RelayIdentity & {
  basisConnId: string
  relayDeviceId: string
  acceptedCredentialVersion: number
  acceptedAs: 'current' | 'grace'
  owningControlGeneration: number
  deadline: number
}

export type ResumeConfirmRequest = RelayIdentity & {
  reqId: string
  basisConnId: string
  owningControlGeneration: number
}

// A retried confirm of the same request answers from here, as relay_confirm_results does.
export const MEMORY_CONFIRM_RESULT_RETENTION_MS = 10 * 60 * 1000

type StoredResult = { basisConnId: string; result: DeviceResumeConfirmed; at: number }

function resultKey(request: RelayIdentity & { reqId: string }): string {
  return `${request.userId}\u0000${request.relayHostId}\u0000${request.reqId}`
}

export class MemoryResumeConfirmations {
  private readonly bases = new Map<string, MemoryConnectionBasis>()
  // Insertion order is age order, so expiry walks from the front.
  private readonly results = new Map<string, StoredResult>()

  constructor(
    private readonly store: RelayCredentialStore,
    private readonly now: () => number = Date.now,
    private readonly onRenewalFailure?: (error: unknown) => void
  ) {}

  open(basis: MemoryConnectionBasis): void {
    this.bases.set(basis.basisConnId, basis)
  }

  close(basisConnId: string): void {
    this.bases.delete(basisConnId)
  }

  // Route by basis ownership, not current switch, so mid-confirm flip cannot send an in-memory basis to nonexistent DB state.
  owns(request: ResumeConfirmRequest): boolean {
    this.expireResults()
    return this.bases.has(request.basisConnId) || this.results.has(resultKey(request))
  }

  async confirm(request: ResumeConfirmRequest): Promise<DeviceResumeConfirmed> {
    this.expireResults()
    const key = resultKey(request)
    const prior = this.results.get(key)
    if (prior) {
      if (prior.basisConnId !== request.basisConnId) throw new RelayStoreError('confirmation_tuple_mismatch')
      return prior.result
    }
    const basis = this.bases.get(request.basisConnId)
    if (
      !basis ||
      basis.userId !== request.userId ||
      basis.relayHostId !== request.relayHostId ||
      basis.owningControlGeneration !== request.owningControlGeneration ||
      basis.deadline < this.now()
    ) {
      throw new RelayStoreError('confirmation_not_active')
    }
    const result = await this.store.confirmMemoryResume(
      {
        userId: basis.userId,
        relayHostId: basis.relayHostId,
        reqId: request.reqId,
        basisConnId: basis.basisConnId,
        relayDeviceId: basis.relayDeviceId,
        acceptedCredentialVersion: basis.acceptedCredentialVersion,
        acceptedAs: basis.acceptedAs
      },
      { onRenewalFailure: this.onRenewalFailure }
    )
    this.results.set(key, { basisConnId: basis.basisConnId, result, at: this.now() })
    return result
  }

  private expireResults(): void {
    const cutoff = this.now() - MEMORY_CONFIRM_RESULT_RETENTION_MS
    for (const [key, stored] of this.results) {
      if (stored.at > cutoff) break
      this.results.delete(key)
    }
  }
}
