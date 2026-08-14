import { randomBytes } from 'node:crypto'
import { sha256 } from './codex-structured-write-digest'
import type {
  CodexStructuredWriteAdmissionReceipt,
  CodexStructuredWriteAuthorization,
  CodexStructuredWriteGrant,
  CodexStructuredWriteReceipt
} from './codex-structured-write-types'

type TurnRequest = Parameters<CodexStructuredWriteAuthorization['authorizeTurn']>[0]
type PendingLease = TurnRequest & {
  capabilityHandle: string
  requestReceiptId: string
  expiresAtMs: number
}

export type CodexStructuredWriteLeaseRegistryDeps = {
  admitTurn: (
    input: TurnRequest
  ) =>
    | Promise<Omit<CodexStructuredWriteGrant, 'capabilityHandle'> | null>
    | Omit<CodexStructuredWriteGrant, 'capabilityHandle'>
    | null
  persistAdmission: (receipt: CodexStructuredWriteAdmissionReceipt) => Promise<void> | void
  persistOutcome: (receipt: CodexStructuredWriteReceipt) => Promise<void> | void
  onOutcomePersistenceFailure?: (input: {
    receipt: CodexStructuredWriteReceipt
    error: unknown
  }) => void
  flushReceipts?: () => Promise<void>
  now?: () => number
  leaseTtlMs?: number
  mintCapabilityHandle?: () => string
}

/** Host-owned, model-invisible compare-and-consume registry for one effect domain. */
export class CodexStructuredWriteLeaseRegistry implements CodexStructuredWriteAuthorization {
  private readonly leases = new Map<string, PendingLease>()
  private readonly handleBySession = new Map<string, string>()
  private readonly latestEpochBySession = new Map<string, number>()
  private readonly issuedHandles = new Set<string>()
  private readonly admittedClientMessages = new Set<string>()
  private readonly pendingClientMessages = new Set<string>()
  private readonly pendingOutcomeWrites = new Set<Promise<void>>()
  private readonly now: () => number
  private readonly leaseTtlMs: number
  private readonly mintCapabilityHandle: () => string

  constructor(private readonly deps: CodexStructuredWriteLeaseRegistryDeps) {
    this.now = deps.now ?? Date.now
    this.leaseTtlMs = deps.leaseTtlMs ?? 120_000
    this.mintCapabilityHandle =
      deps.mintCapabilityHandle ?? (() => randomBytes(32).toString('base64url'))
  }

  authorizeTurn = async (input: TurnRequest): Promise<CodexStructuredWriteGrant | null> => {
    this.revokeSession(input.sessionId)
    this.latestEpochBySession.set(input.sessionId, input.turnEpoch)
    const clientMessageKey = sha256(
      `${input.sessionId.length}:${input.sessionId}${input.clientMessageId}`
    )
    if (
      this.admittedClientMessages.has(clientMessageKey) ||
      this.pendingClientMessages.has(clientMessageKey)
    ) {
      return null
    }
    this.pendingClientMessages.add(clientMessageKey)
    let admitted: Omit<CodexStructuredWriteGrant, 'capabilityHandle'> | null
    try {
      admitted = await this.deps.admitTurn(input)
    } finally {
      this.pendingClientMessages.delete(clientMessageKey)
    }
    if (admitted) {
      this.admittedClientMessages.add(clientMessageKey)
    }
    if (this.latestEpochBySession.get(input.sessionId) !== input.turnEpoch) {
      return null
    }
    if (!admitted) {
      return null
    }
    if (admitted.writableRoot !== input.writableRoot) {
      throw new Error('host admission changed the selected writable worktree')
    }
    const capabilityHandle = this.mintCapabilityHandle()
    if (!capabilityHandle || this.issuedHandles.has(capabilityHandle)) {
      throw new Error('host capability handle is empty or was already issued')
    }
    this.issuedHandles.add(capabilityHandle)
    this.leases.set(capabilityHandle, {
      ...input,
      capabilityHandle,
      requestReceiptId: admitted.requestReceiptId,
      expiresAtMs: this.now() + this.leaseTtlMs
    })
    this.handleBySession.set(input.sessionId, capabilityHandle)
    return { ...admitted, capabilityHandle }
  }

  consumeLease = async (input: {
    capabilityHandle: string
    receipt: CodexStructuredWriteAdmissionReceipt
  }): Promise<void> => {
    // Delete before the first await: competing calls in this process cannot
    // both pass the comparison and persistence boundary.
    const lease = this.leases.get(input.capabilityHandle)
    if (!lease) {
      throw new Error('structured write capability is unknown or already consumed')
    }
    this.leases.delete(input.capabilityHandle)
    if (this.handleBySession.get(lease.sessionId) === input.capabilityHandle) {
      this.handleBySession.delete(lease.sessionId)
    }
    assertAdmissionMatchesLease(lease, input.receipt, this.now())
    await this.deps.persistAdmission(input.receipt)
  }

  onReceipt = (receipt: CodexStructuredWriteReceipt): void => {
    // Start on a resolved promise so a synchronous persistence throw follows
    // the same non-product-fatal reporting path as an async rejection.
    const operation = Promise.resolve()
      .then(() => this.deps.persistOutcome(receipt))
      .catch((error: unknown) => {
        this.deps.onOutcomePersistenceFailure?.({ receipt, error })
      })
    this.pendingOutcomeWrites.add(operation)
    void operation.finally(() => this.pendingOutcomeWrites.delete(operation))
  }

  onReceiptFailure = (input: { receipt: CodexStructuredWriteReceipt; error: unknown }): void => {
    this.deps.onOutcomePersistenceFailure?.(input)
  }

  flushReceipts = async (): Promise<void> => {
    while (this.pendingOutcomeWrites.size > 0) {
      await Promise.all(this.pendingOutcomeWrites)
    }
    await this.deps.flushReceipts?.()
  }

  revokeSession(sessionId: string): void {
    const handle = this.handleBySession.get(sessionId)
    if (handle) {
      this.handleBySession.delete(sessionId)
      this.leases.delete(handle)
    }
    this.latestEpochBySession.delete(sessionId)
  }
}

function assertAdmissionMatchesLease(
  lease: PendingLease,
  receipt: CodexStructuredWriteAdmissionReceipt,
  now: number
): void {
  const matches =
    lease.expiresAtMs >= now &&
    receipt.requestReceiptId === lease.requestReceiptId &&
    receipt.sessionId === lease.sessionId &&
    receipt.turnEpoch === lease.turnEpoch &&
    receipt.fence === lease.fence &&
    receipt.clientMessageId === lease.clientMessageId &&
    receipt.requestDigest === lease.requestDigest &&
    receipt.worktreeRoot === lease.writableRoot &&
    receipt.capabilityHandleDigest === sha256(lease.capabilityHandle)
  if (!matches) {
    throw new Error('structured write admission does not match its host capability')
  }
}
