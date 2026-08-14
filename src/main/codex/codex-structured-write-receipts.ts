import { snapshotChanges } from './codex-structured-write-manifest'
import type {
  CodexObservedFileChange,
  CodexStructuredWriteAuthorization,
  CodexStructuredWriteReceipt
} from './codex-structured-write-types'
import { LOCAL_STRUCTURED_WRITE_EFFECT } from './codex-structured-write-types'

export class CodexStructuredWriteReceiptEmitter {
  constructor(
    private readonly authorization: CodexStructuredWriteAuthorization,
    private readonly now: () => number,
    private readonly mintId: () => string
  ) {}

  async completed(
    sessionId: string,
    observed: CodexObservedFileChange,
    status: CodexStructuredWriteReceipt['outcome']
  ): Promise<void> {
    const admission = observed.admission
    const before = observed.before
    if (!admission || !before) {
      return
    }
    let snapshotFailed = false
    const after = await snapshotChanges(admission.worktreeRoot, observed.changes).catch(() => {
      snapshotFailed = true
      return []
    })
    this.emit(this.receipt(sessionId, observed, before, after, snapshotFailed ? 'failed' : status))
  }

  async failed(sessionId: string, observed: CodexObservedFileChange): Promise<void> {
    const admission = observed.admission
    const before = observed.before
    if (!admission || !before) {
      return
    }
    const after = await snapshotChanges(admission.worktreeRoot, observed.changes).catch(() => [])
    this.emit(this.receipt(sessionId, observed, before, after, 'failed'))
  }

  private receipt(
    sessionId: string,
    observed: CodexObservedFileChange,
    before: NonNullable<CodexObservedFileChange['before']>,
    after: NonNullable<CodexObservedFileChange['before']>,
    outcome: CodexStructuredWriteReceipt['outcome']
  ): CodexStructuredWriteReceipt {
    const admission = observed.admission as NonNullable<CodexObservedFileChange['admission']>
    return {
      protocolVersion: 1,
      receiptId: this.mintId(),
      requestReceiptId: admission.requestReceiptId,
      effectDomain: LOCAL_STRUCTURED_WRITE_EFFECT,
      sessionId,
      turnEpoch: admission.turnEpoch,
      fence: admission.fence,
      clientMessageId: admission.clientMessageId,
      threadId: observed.threadId,
      turnId: observed.turnId,
      requestDigest: admission.requestDigest,
      toolUseId: observed.itemId,
      changePlanDigest: observed.changePlanDigest,
      worktreeRoot: admission.worktreeRoot,
      capabilityHandleDigest: admission.capabilityHandleDigest,
      before,
      after,
      outcome,
      completedAtMs: this.now()
    }
  }

  private emit(receipt: CodexStructuredWriteReceipt): void {
    try {
      this.authorization.onReceipt(receipt)
    } catch (error) {
      this.authorization.onReceiptFailure?.({ receipt, error })
    }
  }
}
