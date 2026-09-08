import type { z } from 'zod'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { secureMobileWebBridgeRequestId } from './mobile-web-bridge-request-encoding'
import { projectHostSessionRuntimeCapabilities } from '../../shared/mobile-web/session-runtime-capabilities'
import { MobileWebSessionTerminalCreation } from './mobile-web-session-terminal-creation'
import {
  MobileWebSessionBrowserCreateResultSchema,
  MobileWebSessionCapabilitiesPayloadSchema,
  MobileWebSessionCloseResultSchema,
  MobileWebSessionHostGatesPayloadSchema,
  MobileWebSessionHostGatesResultSchema,
  MobileWebSessionSnapshotResultSchema,
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
  MobileWebQuickCommandLaunchResultSchema,
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
  private readonly terminalCreation: MobileWebSessionTerminalCreation

  constructor(private readonly requests: MobileWebOneShotRequestClient) {
    this.terminalCreation = new MobileWebSessionTerminalCreation(requests)
  }

  private host<T>(
    operation:
      | 'snapshot'
      | 'activate'
      | 'close'
      | 'createBrowser'
      | 'quickCommands'
      | 'quickCommandMutate'
      | 'createQuickCommand',
    payload: { workspaceId: string },
    schema: z.ZodType<T>
  ): Promise<T> {
    const params =
      operation === 'createQuickCommand'
        ? { ...payload, clientMutationId: secureMobileWebBridgeRequestId(), timeoutMs: 15_000 }
        : { ...payload }
    return requestMobileWebHost(
      this.requests,
      `mobileWeb.session.${operation}`,
      payload.workspaceId,
      params
    ).then((result) => {
      const parsed = schema.safeParse(result)
      if (!parsed.success) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed.data
    })
  }

  capabilities(
    payload: MobileWebSessionCapabilitiesPayload
  ): Promise<MobileWebSessionCapabilitiesResult> {
    MobileWebSessionCapabilitiesPayloadSchema.parse(payload)
    return this.hostGates({ includeHostGates: true }).then((result) =>
      projectHostSessionRuntimeCapabilities(result.hostCapabilities)
    )
  }

  hostGates(payload: MobileWebSessionHostGatesPayload): Promise<MobileWebSessionHostGatesResult> {
    MobileWebSessionHostGatesPayloadSchema.parse(payload)
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.session.capabilities',
      undefined,
      {}
    ).then((result) => MobileWebSessionHostGatesResultSchema.parse(result))
  }

  snapshot(payload: MobileWebSessionSnapshotPayload): Promise<MobileWebSessionSnapshotResult> {
    return this.host('snapshot', payload, MobileWebSessionSnapshotResultSchema).then((result) =>
      requireEchoedWorkspaceId(payload.workspaceId, result)
    )
  }

  activate(payload: MobileWebSessionTabActionPayload): Promise<MobileWebSessionSnapshotResult> {
    return this.host('activate', payload, MobileWebSessionSnapshotResultSchema).then((result) => {
      requireEchoedWorkspaceId(payload.workspaceId, result)
      if (result.activeTabId !== payload.tabId) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return result
    })
  }

  create(payload: MobileWebSessionCreatePayload): Promise<MobileWebSessionCreateResult> {
    return this.terminalCreation.create(payload)
  }

  agentOptions(
    payload: MobileWebSessionAgentOptionsPayload
  ): Promise<MobileWebSessionAgentOptionsResult> {
    return this.terminalCreation.agentOptions(payload)
  }

  createAgent(payload: MobileWebSessionCreateAgentPayload): Promise<MobileWebSessionCreateResult> {
    return this.terminalCreation.create(payload)
  }

  quickCommands(
    payload: MobileWebQuickCommandSnapshotPayload
  ): Promise<MobileWebQuickCommandSnapshotResult> {
    return this.host('quickCommands', payload, MobileWebQuickCommandSnapshotResultSchema)
  }

  quickCommandMutate(
    payload: MobileWebQuickCommandMutationPayload
  ): Promise<MobileWebQuickCommandSnapshotResult> {
    return this.host('quickCommandMutate', payload, MobileWebQuickCommandSnapshotResultSchema)
  }

  createQuickCommand(
    payload: MobileWebQuickCommandLaunchPayload
  ): Promise<MobileWebQuickCommandLaunchResult> {
    return this.host('createQuickCommand', payload, MobileWebQuickCommandLaunchResultSchema).then(
      (result) => requireEchoedWorkspaceId(payload.workspaceId, result)
    )
  }

  createBrowser(
    payload: MobileWebSessionBrowserCreatePayload
  ): Promise<MobileWebSessionBrowserCreateResult> {
    return this.host('createBrowser', payload, MobileWebSessionBrowserCreateResultSchema).then(
      (result) => requireEchoedWorkspaceId(payload.workspaceId, result)
    )
  }

  close(payload: MobileWebSessionTabActionPayload): Promise<MobileWebSessionCloseResult> {
    return this.host('close', payload, MobileWebSessionCloseResultSchema).then((result) => {
      requireEchoedWorkspaceId(payload.workspaceId, result)
      if (result.tabId !== payload.tabId) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return result
    })
  }
}
