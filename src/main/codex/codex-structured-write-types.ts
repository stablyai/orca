import type {
  CodexStructuredFileChange,
  CodexStructuredFileManifestEntry
} from './codex-structured-write-manifest'

export const LOCAL_STRUCTURED_WRITE_EFFECT = 'local_structured_write' as const

export type CodexStructuredWriteGrant = {
  requestReceiptId: string
  writableRoot: string
  /** Host-registry handle. It is passed back only to the host consume callback. */
  capabilityHandle: string
}

export type CodexStructuredWriteAdmissionReceipt = {
  protocolVersion: 1
  requestReceiptId: string
  effectDomain: typeof LOCAL_STRUCTURED_WRITE_EFFECT
  sessionId: string
  turnEpoch: number
  fence: number
  clientMessageId: string
  threadId: string
  turnId: string
  requestDigest: string
  toolUseId: string
  changePlanDigest: string
  worktreeRoot: string
  capabilityHandleDigest: string
  before: CodexStructuredFileManifestEntry[]
  admittedAtMs: number
}

export type CodexStructuredWriteAuthorization = {
  authorizeTurn: (input: {
    sessionId: string
    turnEpoch: number
    fence: number
    clientMessageId: string
    requestDigest: string
    writableRoot: string
    requestAuthority?: {
      effectAuthority: typeof LOCAL_STRUCTURED_WRITE_EFFECT
      requestReceiptId: string
    }
  }) => Promise<CodexStructuredWriteGrant | null> | CodexStructuredWriteGrant | null
  /** Must atomically compare-and-consume the opaque handle before mutation. */
  consumeLease: (input: {
    capabilityHandle: string
    receipt: CodexStructuredWriteAdmissionReceipt
  }) => Promise<void> | void
  revokeSession?: (sessionId: string) => void
  onReceipt: (receipt: CodexStructuredWriteReceipt) => void
  onReceiptFailure?: (input: { receipt: CodexStructuredWriteReceipt; error: unknown }) => void
  /** Drains asynchronous evaluation-only receipts during host shutdown. */
  flushReceipts?: () => Promise<void>
}

export type CodexStructuredWriteReceipt = {
  protocolVersion: 1
  receiptId: string
  requestReceiptId: string
  effectDomain: typeof LOCAL_STRUCTURED_WRITE_EFFECT
  sessionId: string
  turnEpoch: number
  fence: number
  clientMessageId: string
  threadId: string
  turnId: string
  requestDigest: string
  toolUseId: string
  changePlanDigest: string
  worktreeRoot: string
  capabilityHandleDigest: string
  before: CodexStructuredFileManifestEntry[]
  after: CodexStructuredFileManifestEntry[]
  outcome: 'completed' | 'failed' | 'declined'
  completedAtMs: number
}

export type CodexStructuredWriteLease = {
  handle: string
  requestReceiptId: string
  sessionId: string
  turnEpoch: number
  fence: number
  clientMessageId: string
  requestDigest: string
  worktreeRoot: string
  threadId: string | null
  turnId: string | null
  state: 'issued' | 'reserved' | 'consumed' | 'revoked'
}

export type CodexObservedFileChange = {
  sessionId: string
  threadId: string
  turnId: string
  itemId: string
  changes: CodexStructuredFileChange[]
  changePlanDigest: string
  before: CodexStructuredFileManifestEntry[] | null
  admission: {
    requestReceiptId: string
    turnEpoch: number
    fence: number
    clientMessageId: string
    requestDigest: string
    worktreeRoot: string
    capabilityHandleDigest: string
  } | null
}

export type CodexStructuredApproval =
  | { handled: false }
  | { handled: true; result: Record<string, unknown> }
