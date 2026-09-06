import {
  MOBILE_WEB_WORKSPACE_LIST_LIMIT,
  MobileWebWorkspaceSnapshotPayloadSchema,
  MobileWebWorkspaceSnapshotResultSchema,
  type MobileWebWorkspaceSnapshotResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { mobileWebWorkspaceSnapshotPage } from './mobile-web-workspace-snapshot'

const MOBILE_WEB_WORKSPACE_HOST_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

type Continuation = {
  cursor: string
  hostResult: unknown
  offset: number
}

export class MobileWebWorkspaceSnapshotPager {
  private continuation: Continuation | null = null
  private active = false
  private nextCursorNumber = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  async snapshot(
    payloadValue: unknown,
    client: RpcClient,
    authority: MobileWebWorkspaceAuthority
  ): Promise<MobileWebWorkspaceSnapshotResult> {
    if (this.active) {
      throw new MobileWebBrokerError('rate_limited')
    }
    this.active = true
    try {
      const payload = MobileWebWorkspaceSnapshotPayloadSchema.parse(payloadValue)
      const continuation = payload.cursor
        ? this.consumeContinuation(payload.cursor)
        : await this.begin(client)
      const page = mobileWebWorkspaceSnapshotPage(
        continuation.hostResult,
        payload.limit,
        authority,
        continuation.offset
      )
      if (page.nextOffset !== null && page.nextOffset === continuation.offset) {
        throw new MobileWebBrokerError('too_large')
      }
      const nextCursor =
        page.nextOffset === null ? null : this.retain(continuation, page.nextOffset)
      return MobileWebWorkspaceSnapshotResultSchema.parse({ ...page.snapshot, nextCursor })
    } finally {
      this.active = false
    }
  }

  clear(): void {
    this.continuation = null
  }

  private async begin(client: RpcClient): Promise<Continuation> {
    this.clear()
    const response = await client.sendRequest('worktree.ps', {
      limit: MOBILE_WEB_WORKSPACE_LIST_LIMIT + 1
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    if (
      mobileWebEncodedByteLength(response.result) > MOBILE_WEB_WORKSPACE_HOST_SNAPSHOT_MAX_BYTES ||
      exceedsWorkspaceLimit(response.result)
    ) {
      throw new MobileWebBrokerError('too_large')
    }
    return { cursor: '', hostResult: response.result, offset: 0 }
  }

  private consumeContinuation(cursor: string): Continuation {
    const continuation = this.continuation
    this.clear()
    if (!continuation || continuation.cursor !== cursor) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return continuation
  }

  private retain(previous: Continuation, offset: number): string {
    const cursor = this.createCursor()
    this.continuation = { cursor, hostResult: previous.hostResult, offset }
    return cursor
  }

  private createCursor(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextCursorNumber.toString(36)
    this.nextCursorNumber += 1
    return `workspace_page_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function exceedsWorkspaceLimit(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.worktrees)) {
    return false
  }
  return (
    value.truncated === true ||
    value.worktrees.length > MOBILE_WEB_WORKSPACE_LIST_LIMIT ||
    (typeof value.totalCount === 'number' && value.totalCount > MOBILE_WEB_WORKSPACE_LIST_LIMIT)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
