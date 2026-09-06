import type { AiVaultListResult } from '../../../src/shared/ai-vault-types'
import {
  MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT,
  MobileWebAgentHistorySnapshotPayloadSchema,
  MobileWebAgentHistorySnapshotResultSchema,
  type MobileWebAgentHistorySession,
  type MobileWebAgentHistorySnapshotPayload,
  type MobileWebAgentHistorySnapshotResult
} from '../../../src/shared/mobile-web/agent-history-operation-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import { deriveMobileAiVaultScopePaths } from '../agent-history/agent-history-scope-paths'
import { MOBILE_AI_VAULT_CAPABILITY } from '../agent-history/agent-history-capability'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import { mobileWebAgentHistoryPresentation } from './mobile-web-agent-history-presentation'

const HOST_RESULT_MAX_BYTES = 8 * 1024 * 1024

type Continuation = {
  cursor: string
  supported: boolean
  sessions: MobileWebAgentHistorySession[]
  skippedTranscriptCount: number
  offset: number
}

export class MobileWebAgentHistoryPager {
  private continuation: Continuation | null = null
  private active = false
  private nextCursorNumber = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  async page(
    payloadValue: unknown,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority,
    sessionAuthority: MobileWebAgentHistoryAuthority
  ): Promise<MobileWebAgentHistorySnapshotResult> {
    if (this.active) {
      throw new MobileWebBrokerError('rate_limited')
    }
    this.active = true
    try {
      const payload = MobileWebAgentHistorySnapshotPayloadSchema.parse(payloadValue)
      const continuation = payload.cursor
        ? this.consume(payload.cursor)
        : await this.begin(payload, client, workspaceAuthority, sessionAuthority)
      const sessions = continuation.sessions.slice(
        continuation.offset,
        continuation.offset + MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT
      )
      const nextOffset = continuation.offset + sessions.length
      const nextCursor =
        nextOffset < continuation.sessions.length ? this.retain(continuation, nextOffset) : null
      return MobileWebAgentHistorySnapshotResultSchema.parse({
        supported: continuation.supported,
        sessions,
        skippedTranscriptCount: continuation.skippedTranscriptCount,
        nextCursor
      })
    } finally {
      this.active = false
    }
  }

  clear(): void {
    this.continuation = null
  }

  private async begin(
    payload: MobileWebAgentHistorySnapshotPayload,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority,
    sessionAuthority: MobileWebAgentHistoryAuthority
  ): Promise<Continuation> {
    this.clear()
    const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const status = await requestResult(client, 'status.get')
    if (!hostSupportsAgentHistory(status)) {
      sessionAuthority.clear()
      return {
        cursor: '',
        supported: false,
        sessions: [],
        skippedTranscriptCount: 0,
        offset: 0
      }
    }
    const worktreeResult = await requestResult(client, 'worktree.ps', { limit: 10_000 })
    const worktrees = worktreeList(worktreeResult)
    const activeWorktree =
      worktrees.find((worktree) => worktree.worktreeId === hostWorkspaceId) ?? null
    const scopePaths = deriveMobileAiVaultScopePaths(payload.scope, activeWorktree, worktrees)
    const historyResult = await requestResult(client, 'aiVault.listSessions', {
      limit: 500,
      force: payload.force,
      scopePaths
    })
    if (mobileWebEncodedByteLength(historyResult) > HOST_RESULT_MAX_BYTES) {
      throw new MobileWebBrokerError('too_large')
    }
    const history = agentHistoryResult(historyResult)
    const presentation = mobileWebAgentHistoryPresentation({
      sessions: history.sessions,
      issues: history.issues,
      scope: payload.scope,
      query: payload.query,
      scopePaths,
      activeWorktreePath: activeWorktree?.path ?? null,
      authority: sessionAuthority
    })
    return {
      cursor: '',
      supported: true,
      ...presentation,
      offset: 0
    }
  }

  private consume(cursor: string): Continuation {
    const continuation = this.continuation
    this.clear()
    if (!continuation || continuation.cursor !== cursor) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return continuation
  }

  private retain(previous: Continuation, offset: number): string {
    const cursor = this.createCursor()
    this.continuation = { ...previous, cursor, offset }
    return cursor
  }

  private createCursor(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextCursorNumber.toString(36)
    this.nextCursorNumber += 1
    return `agent_history_page_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

async function requestResult(
  client: RpcClient,
  method: string,
  params?: unknown
): Promise<unknown> {
  const response = await client.sendRequest(method, params)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return response.result
}

function hostSupportsAgentHistory(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.includes(MOBILE_AI_VAULT_CAPABILITY)
  )
}

function worktreeList(value: unknown): Worktree[] {
  if (!isRecord(value) || !Array.isArray(value.worktrees)) {
    throw new MobileWebBrokerError('host_error')
  }
  return value.worktrees as Worktree[]
}

function agentHistoryResult(value: unknown): AiVaultListResult {
  if (!isRecord(value) || !Array.isArray(value.sessions) || !Array.isArray(value.issues)) {
    throw new MobileWebBrokerError('host_error')
  }
  return value as AiVaultListResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
