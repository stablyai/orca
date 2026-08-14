import { realpath } from 'node:fs/promises'
import { sha256 } from './codex-structured-write-digest'
import { snapshotChanges, snapshotLinkedWorktreeRoot } from './codex-structured-write-manifest'
import {
  LOCAL_STRUCTURED_WRITE_EFFECT,
  type CodexObservedFileChange,
  type CodexStructuredApproval,
  type CodexStructuredWriteAdmissionReceipt,
  type CodexStructuredWriteAuthorization,
  type CodexStructuredWriteLease
} from './codex-structured-write-types'

export async function admitStructuredFileChange(input: {
  sessionId: string
  threadId: string
  turnId: string
  grantRoot: string | null
  expectedWorktreeIdentity: string
  lease: CodexStructuredWriteLease
  observed: CodexObservedFileChange
  authorization: CodexStructuredWriteAuthorization
  now: () => number
  isCurrent: () => boolean
}): Promise<CodexStructuredApproval> {
  const { lease, observed } = input
  lease.state = 'reserved'
  try {
    const initialWorktree = await snapshotLinkedWorktreeRoot(lease.worktreeRoot)
    if (
      initialWorktree.root !== lease.worktreeRoot ||
      initialWorktree.identity !== input.expectedWorktreeIdentity
    ) {
      throw new Error('host-selected worktree changed before file admission')
    }
    if (input.grantRoot && (await realpath(input.grantRoot)) !== lease.worktreeRoot) {
      throw new Error('file change requested a different grant root')
    }
    observed.before = await snapshotChanges(lease.worktreeRoot, observed.changes)
    const admittedWorktree = await snapshotLinkedWorktreeRoot(lease.worktreeRoot)
    if (
      admittedWorktree.root !== lease.worktreeRoot ||
      admittedWorktree.identity !== initialWorktree.identity
    ) {
      throw new Error('host-selected worktree changed during file admission')
    }
    if (!input.isCurrent()) {
      throw new Error('structured write lease was revoked during admission')
    }
    const capabilityHandleDigest = sha256(lease.handle)
    const admissionReceipt: CodexStructuredWriteAdmissionReceipt = {
      protocolVersion: 1,
      requestReceiptId: lease.requestReceiptId,
      effectDomain: LOCAL_STRUCTURED_WRITE_EFFECT,
      sessionId: input.sessionId,
      turnEpoch: lease.turnEpoch,
      fence: lease.fence,
      clientMessageId: lease.clientMessageId,
      threadId: input.threadId,
      turnId: input.turnId,
      requestDigest: lease.requestDigest,
      toolUseId: observed.itemId,
      changePlanDigest: observed.changePlanDigest,
      worktreeRoot: lease.worktreeRoot,
      capabilityHandleDigest,
      before: observed.before,
      admittedAtMs: input.now()
    }
    await input.authorization.consumeLease({
      capabilityHandle: lease.handle,
      receipt: admissionReceipt
    })
    if (!input.isCurrent()) {
      throw new Error('structured write lease was revoked while the host consumed it')
    }
    observed.admission = {
      requestReceiptId: lease.requestReceiptId,
      turnEpoch: lease.turnEpoch,
      fence: lease.fence,
      clientMessageId: lease.clientMessageId,
      requestDigest: lease.requestDigest,
      worktreeRoot: lease.worktreeRoot,
      capabilityHandleDigest
    }
    lease.state = 'consumed'
    return { handled: true, result: { decision: 'accept' } }
  } catch {
    lease.state = 'revoked'
    return { handled: true, result: { decision: 'decline' } }
  }
}
