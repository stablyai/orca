import {
  MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS,
  MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS,
  MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS,
  MobileWebSourceControlCancelCommitMessagePayloadSchema,
  MobileWebSourceControlCancelCommitMessageResultSchema,
  MobileWebSourceControlGenerateCommitMessagePayloadSchema,
  MobileWebSourceControlGenerateCommitMessageResultSchema,
  type MobileWebSourceControlCancelCommitMessageResult,
  type MobileWebSourceControlGenerateCommitMessageResult
} from '../../../src/shared/mobile-web/source-control-commit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { assertFreshMobileWebCommitSnapshot } from './mobile-web-source-control-commit-preflight'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const COMMIT_MESSAGE_GENERATION_TIMEOUT_MS = 65_000

type ActiveGeneration = {
  client: RpcClient
  pageWorkspaceId: string
  hostWorkspaceId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
  cancelled: boolean
}

export class MobileWebCommitMessageGeneration {
  private readonly active = new Map<string, ActiveGeneration>()
  private disposed = false

  async generate(args: {
    requestId: string
    payload: unknown
    client: RpcClient
    workspaceAuthority: MobileWebWorkspaceAuthority
  }): Promise<MobileWebSourceControlGenerateCommitMessageResult> {
    const payload = MobileWebSourceControlGenerateCommitMessagePayloadSchema.parse(args.payload)
    if (this.disposed || this.active.has(args.requestId)) {
      throw new MobileWebBrokerError('cancelled')
    }
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const generation: ActiveGeneration = {
      client: args.client,
      pageWorkspaceId: payload.workspaceId,
      hostWorkspaceId,
      workspaceAuthority: args.workspaceAuthority,
      cancelled: false
    }
    this.active.set(args.requestId, generation)
    try {
      await assertFreshMobileWebCommitSnapshot(args.client, payload, hostWorkspaceId)
      this.assertAuthorized(generation)
      if (generation.cancelled || this.disposed) {
        return cancelledResult(payload.workspaceId, payload.expectedHead)
      }
      const response = await args.client.sendRequest(
        'git.generateCommitMessage',
        { worktree: `id:${hostWorkspaceId}` },
        { timeoutMs: COMMIT_MESSAGE_GENERATION_TIMEOUT_MS }
      )
      if (generation.cancelled || this.disposed) {
        return cancelledResult(payload.workspaceId, payload.expectedHead)
      }
      this.assertAuthorized(generation)
      if (!response.ok || !isRecord(response.result)) {
        throw new MobileWebBrokerError('host_error')
      }
      if (response.result.success !== true) {
        return generationFailureResult(response.result, payload.workspaceId, payload.expectedHead)
      }
      const message = boundedNonemptyString(
        response.result.message,
        MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS
      )
      if (!message) {
        throw new MobileWebBrokerError('host_error')
      }
      // Why: generation can be slow over SSH; discard a draft if HEAD or the staged index changed.
      await assertFreshMobileWebCommitSnapshot(args.client, payload, hostWorkspaceId)
      this.assertAuthorized(generation)
      if (generation.cancelled || this.disposed) {
        return cancelledResult(payload.workspaceId, payload.expectedHead)
      }
      return MobileWebSourceControlGenerateCommitMessageResultSchema.parse({
        workspaceId: payload.workspaceId,
        previousHead: payload.expectedHead,
        status: 'generated',
        message,
        ...(boundedNonemptyString(
          response.result.agentLabel,
          MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS
        )
          ? {
              agentLabel: boundedNonemptyString(
                response.result.agentLabel,
                MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS
              )
            }
          : {})
      })
    } finally {
      if (this.active.get(args.requestId) === generation) {
        this.active.delete(args.requestId)
      }
    }
  }

  async cancel(
    payload: unknown,
    currentClient: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority
  ): Promise<MobileWebSourceControlCancelCommitMessageResult> {
    const parsed = MobileWebSourceControlCancelCommitMessagePayloadSchema.parse(payload)
    const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(parsed.workspaceId)
    const matching = [...this.active.values()].filter(
      (generation) =>
        generation.pageWorkspaceId === parsed.workspaceId &&
        generation.hostWorkspaceId === hostWorkspaceId
    )
    const targets = matching.length > 0 ? matching : [{ client: currentClient, hostWorkspaceId }]
    matching.forEach((generation) => {
      generation.cancelled = true
    })
    const responses = await Promise.all(
      targets.map(({ client, hostWorkspaceId: target }) => requestCancellation(client, target))
    )
    if (responses.some((response) => !response)) {
      throw new MobileWebBrokerError('host_error')
    }
    return MobileWebSourceControlCancelCommitMessageResultSchema.parse({
      workspaceId: parsed.workspaceId,
      cancellationRequested: true
    })
  }

  async cancelByRequest(requestId: string): Promise<void> {
    const generation = this.active.get(requestId)
    if (!generation) {
      return
    }
    generation.cancelled = true
    await requestCancellation(generation.client, generation.hostWorkspaceId)
  }

  replaceClient(client: RpcClient | null): void {
    for (const generation of this.active.values()) {
      if (generation.client !== client) {
        generation.cancelled = true
        void requestCancellation(generation.client, generation.hostWorkspaceId)
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const generation of this.active.values()) {
      generation.cancelled = true
      void requestCancellation(generation.client, generation.hostWorkspaceId)
    }
    this.active.clear()
  }

  private assertAuthorized(generation: ActiveGeneration): void {
    try {
      if (
        generation.workspaceAuthority.hostWorkspaceId(generation.pageWorkspaceId) ===
        generation.hostWorkspaceId
      ) {
        return
      }
    } catch {
      // Revoked page handles must not receive results from an earlier workspace binding.
    }
    generation.cancelled = true
    void requestCancellation(generation.client, generation.hostWorkspaceId)
    throw new MobileWebBrokerError('not_found')
  }
}

function generationFailureResult(
  result: Record<string, unknown>,
  workspaceId: string,
  previousHead: string
): MobileWebSourceControlGenerateCommitMessageResult {
  if (result.canceled === true) {
    return cancelledResult(workspaceId, previousHead)
  }
  return MobileWebSourceControlGenerateCommitMessageResultSchema.parse({
    workspaceId,
    previousHead,
    status: 'failed',
    error:
      boundedNonemptyString(result.error, MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS) ??
      'The paired Desktop could not generate a commit message.'
  })
}

function cancelledResult(
  workspaceId: string,
  previousHead: string
): MobileWebSourceControlGenerateCommitMessageResult {
  return MobileWebSourceControlGenerateCommitMessageResultSchema.parse({
    workspaceId,
    previousHead,
    status: 'cancelled'
  })
}

async function requestCancellation(client: RpcClient, hostWorkspaceId: string): Promise<boolean> {
  try {
    const response = await client.sendRequest('git.cancelGenerateCommitMessage', {
      worktree: `id:${hostWorkspaceId}`
    })
    return response.ok
  } catch {
    return false
  }
}

function boundedNonemptyString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
