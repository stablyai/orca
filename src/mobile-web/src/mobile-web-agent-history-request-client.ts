import {
  MobileWebAgentHistoryPreviewPayloadSchema,
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistoryResumePayloadSchema,
  MobileWebAgentHistoryResumeResultSchema,
  MobileWebAgentHistorySnapshotPayloadSchema,
  MobileWebAgentHistorySnapshotResultSchema,
  type MobileWebAgentHistoryPreviewResult,
  type MobileWebAgentHistoryResumePayload,
  type MobileWebAgentHistoryResumeResult,
  type MobileWebAgentHistorySnapshotPayload,
  type MobileWebAgentHistorySnapshotResult
} from '../../shared/mobile-web/agent-history-operation-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebAgentHistoryRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  snapshot(
    payload: MobileWebAgentHistorySnapshotPayload
  ): Promise<MobileWebAgentHistorySnapshotResult> {
    return this.requests.request(
      'agentHistory',
      'snapshot',
      payload,
      MobileWebAgentHistorySnapshotPayloadSchema,
      MobileWebAgentHistorySnapshotResultSchema
    )
  }

  preview(sessionHandle: string): Promise<MobileWebAgentHistoryPreviewResult> {
    return this.requests.request(
      'agentHistory',
      'preview',
      { sessionHandle },
      MobileWebAgentHistoryPreviewPayloadSchema,
      MobileWebAgentHistoryPreviewResultSchema
    )
  }

  resume(payload: MobileWebAgentHistoryResumePayload): Promise<MobileWebAgentHistoryResumeResult> {
    return this.requests.request(
      'agentHistory',
      'resume',
      payload,
      MobileWebAgentHistoryResumePayloadSchema,
      MobileWebAgentHistoryResumeResultSchema
    )
  }
}
