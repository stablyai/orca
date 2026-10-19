import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import { RelayOuterError } from './mobile-relay-e2ee-link'

// Only a relay-hello refusal is the relay's verdict on a credential; a bare 4401
// close also covers a first-frame timeout, which proves nothing about it.
export function isExplicitCredentialRejection(error: unknown): boolean {
  return (
    error instanceof RelayOuterError &&
    error.rejectedByRelayHello &&
    error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
  )
}

type RelayCredentialLease = { expiresAt: number; version: number }

// Why: only a rejected outer credential can be repaired by the grace token;
// retrying session/capacity close codes immediately recreates relay churn.
export function relayFailureAllowsGraceRetry(error: Error): boolean {
  return (
    error instanceof RelayOuterError && error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
  )
}

export class RelayCredentialEligibility {
  private readonly rejectedVersions = new Set<number>()

  constructor(private readonly now: () => number) {}

  hasRejected(): boolean {
    return this.rejectedVersions.size > 0
  }

  clearRejected(): void {
    this.rejectedVersions.clear()
  }

  isRejected(version: number): boolean {
    return this.rejectedVersions.has(version)
  }

  recordRejected(version: number): void {
    this.rejectedVersions.add(version)
  }

  hasDialable(...credentials: (RelayCredentialLease | null | undefined)[]): boolean {
    return credentials.some((credential) => this.isDialable(credential))
  }

  eligible<T extends RelayCredentialLease>(...credentials: (T | null | undefined)[]): T[] {
    return credentials.filter((credential): credential is T => this.isDialable(credential))
  }

  private isDialable<T extends RelayCredentialLease>(
    credential: T | null | undefined
  ): credential is T {
    return Boolean(
      credential &&
      credential.expiresAt > this.now() &&
      !this.rejectedVersions.has(credential.version)
    )
  }
}
