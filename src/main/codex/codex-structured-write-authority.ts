import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { admitStructuredFileChange } from './codex-structured-write-admission'
import { parseFileChanges, validateLinkedWorktreeRoot } from './codex-structured-write-manifest'
import { digestRequest, digestStructuredValue } from './codex-structured-write-digest'
import {
  LOCAL_STRUCTURED_WRITE_EFFECT,
  type CodexObservedFileChange,
  type CodexStructuredApproval,
  type CodexStructuredWriteAuthorization,
  type CodexStructuredWriteLease
} from './codex-structured-write-types'
import { CodexStructuredWriteReceiptEmitter } from './codex-structured-write-receipts'

export type { CodexStructuredFileManifestEntry } from './codex-structured-write-manifest'
export { digestRequest, LOCAL_STRUCTURED_WRITE_EFFECT }
export type {
  CodexStructuredApproval,
  CodexStructuredWriteAdmissionReceipt,
  CodexStructuredWriteAuthorization,
  CodexStructuredWriteGrant,
  CodexStructuredWriteReceipt
} from './codex-structured-write-types'

const COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
const FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval'
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval'

export class CodexStructuredWriteAuthority {
  private readonly roots = new Map<string, string>()
  private readonly epochs = new Map<string, number>()
  private readonly leases = new Map<string, CodexStructuredWriteLease>()
  private readonly fileChanges = new Map<string, CodexObservedFileChange>()
  private readonly pendingCompletions = new Set<Promise<void>>()
  private readonly receipts: CodexStructuredWriteReceiptEmitter

  constructor(
    private readonly authorization: CodexStructuredWriteAuthorization,
    private readonly now: () => number = Date.now,
    mintHandle: () => string = () => randomBytes(32).toString('base64url')
  ) {
    this.receipts = new CodexStructuredWriteReceiptEmitter(authorization, now, mintHandle)
  }

  async bindSession(sessionId: string, worktreeRoot: string): Promise<void> {
    if (this.roots.has(sessionId)) {
      this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    }
    this.roots.set(sessionId, await validateLinkedWorktreeRoot(worktreeRoot))
    this.revokeTurn(sessionId)
  }

  async openTurn(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestAuthority?: {
      effectAuthority: typeof LOCAL_STRUCTURED_WRITE_EFFECT
      requestReceiptId: string
    }
  }): Promise<number | null> {
    const worktreeRoot = this.requireRoot(input.sessionId)
    const turnEpoch = (this.epochs.get(input.sessionId) ?? 0) + 1
    this.epochs.set(input.sessionId, turnEpoch)
    this.revokeTurn(input.sessionId)
    const requestDigest = digestRequest(input.body)
    const grant = await this.authorization.authorizeTurn({
      sessionId: input.sessionId,
      turnEpoch,
      fence: input.fence,
      clientMessageId: input.clientMessageId,
      requestDigest,
      writableRoot: worktreeRoot,
      ...(input.requestAuthority ? { requestAuthority: input.requestAuthority } : {})
    })
    if (!grant) {
      return null
    }
    if (
      this.epochs.get(input.sessionId) !== turnEpoch ||
      this.roots.get(input.sessionId) !== worktreeRoot
    ) {
      return null
    }
    if (!grant.requestReceiptId.trim()) {
      throw new Error('structured write grant has no host request receipt')
    }
    if (!grant.capabilityHandle.trim()) {
      throw new Error('structured write grant has no opaque capability handle')
    }
    if ((await realpath(grant.writableRoot)) !== worktreeRoot) {
      throw new Error('structured write grant names a different writable worktree')
    }
    if (
      this.epochs.get(input.sessionId) !== turnEpoch ||
      this.roots.get(input.sessionId) !== worktreeRoot
    ) {
      return null
    }
    this.leases.set(input.sessionId, {
      handle: grant.capabilityHandle,
      requestReceiptId: grant.requestReceiptId,
      sessionId: input.sessionId,
      turnEpoch,
      fence: input.fence,
      clientMessageId: input.clientMessageId,
      requestDigest,
      worktreeRoot,
      threadId: null,
      turnId: null,
      state: 'issued'
    })
    return turnEpoch
  }

  bindTurn(sessionId: string, threadId: string, turnId: string, turnEpoch: number): void {
    const lease = this.leases.get(sessionId)
    if (!lease || lease.state !== 'issued' || lease.turnEpoch !== turnEpoch) {
      return
    }
    if (lease.threadId && (lease.threadId !== threadId || lease.turnId !== turnId)) {
      lease.state = 'revoked'
      return
    }
    lease.threadId = threadId
    lease.turnId = turnId
  }

  observeNotification(sessionId: string, method: string, params: unknown): void {
    if (method === 'item/started') {
      const record = asRecord(params)
      const item = asRecord(record.item)
      if (item.type !== 'fileChange' || typeof item.id !== 'string') {
        return
      }
      const threadId = readString(record, 'threadId')
      const turnId = readString(record, 'turnId')
      const changes = parseFileChanges(item.changes)
      if (!threadId || !turnId || !changes) {
        return
      }
      this.fileChanges.set(this.itemKey(sessionId, item.id), {
        sessionId,
        threadId,
        turnId,
        itemId: item.id,
        changes,
        changePlanDigest: digestStructuredValue(changes),
        before: null,
        admission: null
      })
      return
    }
    if (method === 'item/completed') {
      this.trackCompletion(
        this.completeFileChange(sessionId, params).catch(() => {
          this.revokeTurn(sessionId)
        })
      )
    }
  }

  async reviewServerRequest(
    sessionId: string,
    method: string,
    params: unknown
  ): Promise<CodexStructuredApproval> {
    if (method === COMMAND_APPROVAL) {
      return { handled: true, result: { decision: 'decline' } }
    }
    if (method === PERMISSIONS_APPROVAL) {
      return { handled: true, result: { permissions: {}, scope: 'turn' } }
    }
    if (method !== FILE_CHANGE_APPROVAL) {
      return { handled: false }
    }
    const request = asRecord(params)
    const itemId = readString(request, 'itemId')
    const threadId = readString(request, 'threadId')
    const turnId = readString(request, 'turnId')
    const lease = this.leases.get(sessionId)
    const observed = itemId ? this.fileChanges.get(this.itemKey(sessionId, itemId)) : undefined
    if (!lease || !observed || !itemId || !threadId || !turnId) {
      return { handled: true, result: { decision: 'decline' } }
    }
    if (
      lease.state !== 'issued' ||
      lease.threadId !== threadId ||
      lease.turnId !== turnId ||
      observed.threadId !== threadId ||
      observed.turnId !== turnId
    ) {
      return { handled: true, result: { decision: 'decline' } }
    }
    return admitStructuredFileChange({
      sessionId,
      threadId,
      turnId,
      grantRoot: readString(request, 'grantRoot'),
      lease,
      observed,
      authorization: this.authorization,
      now: this.now,
      isCurrent: () => this.leases.get(sessionId) === lease && lease.state === 'reserved'
    })
  }

  revokeSession(sessionId: string): void {
    this.failAdmittedChanges(sessionId)
    this.revokeTurn(sessionId)
    this.roots.delete(sessionId)
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
  }

  revokePendingTurn(sessionId: string): void {
    this.revokeTurn(sessionId)
  }

  invalidateForNewTurn(sessionId: string): void {
    this.requireRoot(sessionId)
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    this.revokeTurn(sessionId)
  }

  async flushReceipts(): Promise<void> {
    while (this.pendingCompletions.size > 0) {
      await Promise.all(this.pendingCompletions)
    }
    await this.authorization.flushReceipts?.()
  }

  private async completeFileChange(sessionId: string, params: unknown): Promise<void> {
    const record = asRecord(params)
    const item = asRecord(record.item)
    if (item.type !== 'fileChange' || typeof item.id !== 'string') {
      return
    }
    const key = this.itemKey(sessionId, item.id)
    const observed = this.fileChanges.get(key)
    const threadId = readString(record, 'threadId')
    const turnId = readString(record, 'turnId')
    if (
      !observed ||
      !observed.admission ||
      !observed.before ||
      threadId !== observed.threadId ||
      turnId !== observed.turnId
    ) {
      return
    }
    this.fileChanges.delete(key)
    const status =
      item.status === 'completed' ? 'completed' : item.status === 'declined' ? 'declined' : 'failed'
    await this.receipts.completed(sessionId, observed, status)
  }

  private requireRoot(sessionId: string): string {
    const root = this.roots.get(sessionId)
    if (!root) {
      throw new Error(`no host-selected writable worktree for ${sessionId}`)
    }
    return root
  }

  private revokeTurn(sessionId: string): void {
    this.authorization.revokeSession?.(sessionId)
    const lease = this.leases.get(sessionId)
    if (lease) {
      lease.state = 'revoked'
      this.leases.delete(sessionId)
    }
    for (const [key, item] of this.fileChanges) {
      if (item.sessionId === sessionId && !item.admission) {
        this.fileChanges.delete(key)
      }
    }
  }

  private failAdmittedChanges(sessionId: string): void {
    for (const [key, observed] of this.fileChanges) {
      if (observed.sessionId !== sessionId || !observed.admission || !observed.before) {
        continue
      }
      this.fileChanges.delete(key)
      this.trackCompletion(this.receipts.failed(sessionId, observed))
    }
  }

  private trackCompletion(completion: Promise<void>): void {
    this.pendingCompletions.add(completion)
    void completion.finally(() => this.pendingCompletions.delete(completion))
  }

  private itemKey(sessionId: string, itemId: string): string {
    return `${encodeURIComponent(sessionId)}:${encodeURIComponent(itemId)}`
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
