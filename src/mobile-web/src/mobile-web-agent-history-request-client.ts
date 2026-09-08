import {
  MobileWebAgentHistoryPreviewPayloadSchema,
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistoryResumePayloadSchema,
  MobileWebAgentHistoryResumeResultSchema,
  MobileWebAgentHistorySnapshotPayloadSchema,
  MobileWebAgentHistorySnapshotResultSchema,
  type MobileWebAgentHistoryPreviewPayload,
  type MobileWebAgentHistoryPreviewResult,
  type MobileWebAgentHistoryResumePayload,
  type MobileWebAgentHistoryResumeResult,
  type MobileWebAgentHistorySnapshotPayload,
  type MobileWebAgentHistorySnapshotResult
} from '../../shared/mobile-web/agent-history-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

/** Sessions are addressed by the agent and provider id the listing reported, so a page reload or
 *  a reconnect can still name the row it is looking at. */
export class MobileWebAgentHistoryRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  snapshot(
    payload: MobileWebAgentHistorySnapshotPayload
  ): Promise<MobileWebAgentHistorySnapshotResult> {
    return this.request(
      MobileWebAgentHistorySnapshotPayloadSchema,
      payload,
      'mobileWeb.agentHistory.snapshot',
      {
        scope: payload.scope,
        query: payload.query,
        force: payload.force,
        ...(payload.offset === undefined ? {} : { offset: payload.offset })
      },
      MobileWebAgentHistorySnapshotResultSchema
    )
  }

  preview(
    payload: MobileWebAgentHistoryPreviewPayload
  ): Promise<MobileWebAgentHistoryPreviewResult> {
    return this.request(
      MobileWebAgentHistoryPreviewPayloadSchema,
      payload,
      'mobileWeb.agentHistory.preview',
      sessionTarget(payload),
      MobileWebAgentHistoryPreviewResultSchema
    )
  }

  resume(payload: MobileWebAgentHistoryResumePayload): Promise<MobileWebAgentHistoryResumeResult> {
    return this.request(
      MobileWebAgentHistoryResumePayloadSchema,
      payload,
      'mobileWeb.agentHistory.resume',
      sessionTarget(payload),
      MobileWebAgentHistoryResumeResultSchema
    )
  }

  private request<T>(
    payloadSchema: { safeParse(value: unknown): { success: boolean } },
    payload: { workspaceId: string },
    method: string,
    params: Record<string, unknown>,
    resultSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } }
  ): Promise<T> {
    if (!payloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(this.requests, method, payload.workspaceId, params).then(
      (result) => {
        const parsed = resultSchema.safeParse(result)
        if (!parsed.success) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return parsed.data as T
      }
    )
  }
}

function sessionTarget(payload: MobileWebAgentHistoryPreviewPayload): Record<string, unknown> {
  return { scope: payload.scope, agent: payload.agent, sessionId: payload.sessionId }
}
