import {
  MobileWebSessionAgentOptionsPayloadSchema,
  MobileWebSessionAgentOptionsResultSchema,
  MobileWebSessionBrowserCreatePayloadSchema,
  MobileWebSessionBrowserCreateResultSchema,
  MobileWebSessionCapabilitiesPayloadSchema,
  MobileWebSessionCapabilitiesResultSchema,
  MobileWebSessionCloseResultSchema,
  MobileWebSessionCreateAgentPayloadSchema,
  MobileWebSessionCreatePayloadSchema,
  MobileWebSessionCreateResultSchema,
  MobileWebSessionHostGatesPayloadSchema,
  MobileWebSessionHostGatesResultSchema,
  MobileWebSessionSnapshotPayloadSchema,
  MobileWebSessionSnapshotResultSchema,
  MobileWebSessionTabActionPayloadSchema,
  type MobileWebSessionAgentOptionsPayload,
  type MobileWebSessionAgentOptionsResult,
  type MobileWebSessionBrowserCreatePayload,
  type MobileWebSessionBrowserCreateResult,
  type MobileWebSessionCapabilitiesPayload,
  type MobileWebSessionCapabilitiesResult,
  type MobileWebSessionCloseResult,
  type MobileWebSessionCreateAgentPayload,
  type MobileWebSessionCreatePayload,
  type MobileWebSessionCreateResult,
  type MobileWebSessionHostGatesPayload,
  type MobileWebSessionHostGatesResult,
  type MobileWebSessionSnapshotPayload,
  type MobileWebSessionSnapshotResult,
  type MobileWebSessionTabActionPayload
} from '../../shared/mobile-web/session-operation-contract'
import {
  MobileWebQuickCommandLaunchPayloadSchema,
  MobileWebQuickCommandLaunchResultSchema,
  MobileWebQuickCommandMutationPayloadSchema,
  MobileWebQuickCommandSnapshotPayloadSchema,
  MobileWebQuickCommandSnapshotResultSchema,
  type MobileWebQuickCommandLaunchPayload,
  type MobileWebQuickCommandLaunchResult,
  type MobileWebQuickCommandMutationPayload,
  type MobileWebQuickCommandSnapshotPayload,
  type MobileWebQuickCommandSnapshotResult
} from '../../shared/mobile-web/session-quick-command-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSessionRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  capabilities(
    payload: MobileWebSessionCapabilitiesPayload
  ): Promise<MobileWebSessionCapabilitiesResult> {
    return this.requests.request(
      'session',
      'capabilities',
      payload,
      MobileWebSessionCapabilitiesPayloadSchema,
      MobileWebSessionCapabilitiesResultSchema
    )
  }

  hostGates(payload: MobileWebSessionHostGatesPayload): Promise<MobileWebSessionHostGatesResult> {
    return this.requests.request(
      'session',
      'capabilities',
      payload,
      MobileWebSessionHostGatesPayloadSchema,
      MobileWebSessionHostGatesResultSchema
    )
  }

  snapshot(payload: MobileWebSessionSnapshotPayload): Promise<MobileWebSessionSnapshotResult> {
    return this.requests
      .request(
        'session',
        'snapshot',
        payload,
        MobileWebSessionSnapshotPayloadSchema,
        MobileWebSessionSnapshotResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  activate(payload: MobileWebSessionTabActionPayload): Promise<MobileWebSessionSnapshotResult> {
    return this.requests
      .request(
        'session',
        'activate',
        payload,
        MobileWebSessionTabActionPayloadSchema,
        MobileWebSessionSnapshotResultSchema
      )
      .then((result) => {
        requireEchoedWorkspaceId(payload.workspaceId, result)
        if (result.activeTabId !== payload.tabId) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  create(payload: MobileWebSessionCreatePayload): Promise<MobileWebSessionCreateResult> {
    return this.requests
      .request(
        'session',
        'create',
        payload,
        MobileWebSessionCreatePayloadSchema,
        MobileWebSessionCreateResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  agentOptions(
    payload: MobileWebSessionAgentOptionsPayload
  ): Promise<MobileWebSessionAgentOptionsResult> {
    return this.requests.request(
      'session',
      'agentOptions',
      payload,
      MobileWebSessionAgentOptionsPayloadSchema,
      MobileWebSessionAgentOptionsResultSchema
    )
  }

  createAgent(payload: MobileWebSessionCreateAgentPayload): Promise<MobileWebSessionCreateResult> {
    return this.requests
      .request(
        'session',
        'createAgent',
        payload,
        MobileWebSessionCreateAgentPayloadSchema,
        MobileWebSessionCreateResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  quickCommands(
    payload: MobileWebQuickCommandSnapshotPayload
  ): Promise<MobileWebQuickCommandSnapshotResult> {
    return this.requests.request(
      'session',
      'quickCommands',
      payload,
      MobileWebQuickCommandSnapshotPayloadSchema,
      MobileWebQuickCommandSnapshotResultSchema
    )
  }

  quickCommandMutate(
    payload: MobileWebQuickCommandMutationPayload
  ): Promise<MobileWebQuickCommandSnapshotResult> {
    return this.requests.request(
      'session',
      'quickCommandMutate',
      payload,
      MobileWebQuickCommandMutationPayloadSchema,
      MobileWebQuickCommandSnapshotResultSchema
    )
  }

  createQuickCommand(
    payload: MobileWebQuickCommandLaunchPayload
  ): Promise<MobileWebQuickCommandLaunchResult> {
    return this.requests
      .request(
        'session',
        'createQuickCommand',
        payload,
        MobileWebQuickCommandLaunchPayloadSchema,
        MobileWebQuickCommandLaunchResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  createBrowser(
    payload: MobileWebSessionBrowserCreatePayload
  ): Promise<MobileWebSessionBrowserCreateResult> {
    return this.requests
      .request(
        'session',
        'createBrowser',
        payload,
        MobileWebSessionBrowserCreatePayloadSchema,
        MobileWebSessionBrowserCreateResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  close(payload: MobileWebSessionTabActionPayload): Promise<MobileWebSessionCloseResult> {
    return this.requests
      .request(
        'session',
        'close',
        payload,
        MobileWebSessionTabActionPayloadSchema,
        MobileWebSessionCloseResultSchema
      )
      .then((result) => {
        requireEchoedWorkspaceId(payload.workspaceId, result)
        if (result.tabId !== payload.tabId) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }
}
