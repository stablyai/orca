import {
  MobileWebSourceControlBranchComparePayloadSchema,
  type MobileWebSourceControlBranchComparePayload,
  type MobileWebSourceControlBranchCompareResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import { sha256 } from '@noble/hashes/sha256'
import { Buffer } from 'buffer/'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import { sanitizeMobileWebBranchCompare } from './mobile-web-source-control-history-sanitizers'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_RESULT_MAX_BYTES = 8 * 1024 * 1024
const MAX_RETAINED_CONTINUATIONS = 8
const DIRECT_REQUEST_ID = 'direct'

type Continuation = {
  workspaceId: string
  baseRef: string
  revision: string
  nextOffset: number
  hostResult: unknown
}

export class MobileWebSourceControlBranchComparePager {
  private readonly continuations: Continuation[] = []
  private readonly claimed = new Map<string, Continuation>()
  private sequence = 0

  claimRequestContinuation(request: {
    requestId: string
    capability: string
    operation: string
    payload: unknown
  }): boolean {
    return (
      request.capability === 'sourceControl' &&
      request.operation === 'branchCompare' &&
      this.claimContinuation(request.payload, request.requestId)
    )
  }

  claimContinuation(payloadValue: unknown, requestId = DIRECT_REQUEST_ID): boolean {
    const parsed = MobileWebSourceControlBranchComparePayloadSchema.safeParse(payloadValue)
    if (!parsed.success || !parsed.data.expectedRevision || this.claimed.has(requestId)) {
      return false
    }
    const payload = parsed.data
    const index = this.continuations.findIndex((continuation) =>
      matchesContinuation(continuation, payload)
    )
    if (index === -1) {
      return false
    }
    const [continuation] = this.continuations.splice(index, 1)
    if (!continuation) {
      return false
    }
    this.claimed.set(requestId, continuation)
    return true
  }

  async page(
    payloadValue: unknown,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority,
    requestId = DIRECT_REQUEST_ID
  ): Promise<MobileWebSourceControlBranchCompareResult> {
    try {
      const payload = MobileWebSourceControlBranchComparePayloadSchema.parse(payloadValue)
      const continuation = payload.expectedRevision ? this.consumeClaim(payload, requestId) : null
      const hostResult = continuation
        ? continuation.hostResult
        : await this.begin(payload, client, workspaceAuthority)
      const sanitized = sanitizeMobileWebBranchCompare(
        hostResult,
        continuation ? { ...payload, expectedRevision: undefined } : payload
      )
      const revision = continuation?.revision ?? this.createRevision(sanitized.revision, requestId)
      const page = { ...sanitized, revision }
      if (page.nextOffset !== null) {
        this.retain({
          workspaceId: payload.workspaceId,
          baseRef: payload.baseRef,
          revision: page.revision,
          nextOffset: page.nextOffset,
          hostResult
        })
      }
      return page
    } finally {
      this.claimed.delete(requestId)
    }
  }

  clear(): void {
    this.continuations.length = 0
    this.claimed.clear()
  }

  releaseClaim(requestId: string): void {
    this.claimed.delete(requestId)
  }

  private async begin(
    payload: MobileWebSourceControlBranchComparePayload,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority
  ): Promise<unknown> {
    if (payload.offset !== 0) {
      throw new MobileWebBrokerError('invalid_request')
    }
    const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await client.sendRequest('git.branchCompare', {
      worktree: `id:${hostWorkspaceId}`,
      baseRef: payload.baseRef
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    if (mobileWebEncodedByteLength(response.result) > HOST_RESULT_MAX_BYTES) {
      throw new MobileWebBrokerError('too_large')
    }
    return response.result
  }

  private consumeClaim(
    payload: MobileWebSourceControlBranchComparePayload,
    requestId: string
  ): Continuation {
    const continuation = this.claimed.get(requestId)
    if (!continuation) {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (continuation.revision !== payload.expectedRevision) {
      throw new MobileWebBrokerError('conflict')
    }
    if (
      continuation.workspaceId !== payload.workspaceId ||
      continuation.baseRef !== payload.baseRef ||
      continuation.nextOffset !== payload.offset
    ) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return continuation
  }

  private retain(continuation: Continuation): void {
    if (this.continuations.length >= MAX_RETAINED_CONTINUATIONS) {
      this.continuations.shift()
    }
    this.continuations.push(continuation)
  }

  private createRevision(contentRevision: string, requestId: string): string {
    this.sequence += 1
    const content = new TextEncoder().encode(`${contentRevision}:${requestId}:${this.sequence}`)
    return Buffer.from(sha256(content)).toString('hex')
  }
}

function matchesContinuation(
  continuation: Continuation,
  payload: MobileWebSourceControlBranchComparePayload
): boolean {
  return (
    continuation.workspaceId === payload.workspaceId &&
    continuation.baseRef === payload.baseRef &&
    continuation.revision === payload.expectedRevision &&
    continuation.nextOffset === payload.offset
  )
}
