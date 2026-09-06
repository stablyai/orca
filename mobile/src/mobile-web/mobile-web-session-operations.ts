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
  MobileWebSessionTabActionPayloadSchema,
  type MobileWebSessionBrowserCreateResult,
  type MobileWebSessionCloseResult,
  type MobileWebSessionCreateResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { parseRuntimeStatusCapabilities } from '../transport/runtime-capability-probe'
import { projectHostSessionRuntimeCapabilities } from '../session/host-session-runtime-capabilities'
import { loadMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-loader'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import {
  confineMobileWebBrowserFileUrl,
  isMobileWebBrowserFileUrl
} from './mobile-web-browser-file-url-confinement'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'
import { executeMobileWebSessionQuickCommandOperation } from './mobile-web-session-quick-command-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const CLOSE_REFUSAL_REASONS = [
  'missing-intent',
  'stale-publication',
  'stale-terminal',
  'live-host-pty',
  'unknown-liveness',
  'retirement-owner'
] as const

export async function executeMobileWebSessionOperation(args: {
  operation: string
  payload: unknown
  requestId: string
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  browserAuthority: MobileWebBrowserAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
}): Promise<unknown> {
  if (
    args.operation === 'quickCommands' ||
    args.operation === 'quickCommandMutate' ||
    args.operation === 'createQuickCommand'
  ) {
    return executeMobileWebSessionQuickCommandOperation({
      operation: args.operation,
      payload: args.payload,
      requestId: args.requestId,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'capabilities') {
    const hostGatesRequest = MobileWebSessionHostGatesPayloadSchema.safeParse(args.payload)
    if (hostGatesRequest.success) {
      const response = await args.client.sendRequest('status.get')
      if (!response.ok) {
        throw mobileWebBrokerHostRpcError(response.error)
      }
      const status = response.result as { floatingWorkspaceEnabled?: unknown }
      const hostCapabilities = (parseRuntimeStatusCapabilities(response.result) ?? []).filter(
        (value) => value.length > 0 && value.length <= 120
      )
      return MobileWebSessionHostGatesResultSchema.parse({
        hostCapabilities: hostCapabilities.slice(0, 256),
        floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true
      })
    }
    MobileWebSessionCapabilitiesPayloadSchema.parse(args.payload)
    const response = await args.client.sendRequest('status.get')
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    const capabilities = parseRuntimeStatusCapabilities(response.result) ?? []
    return MobileWebSessionCapabilitiesResultSchema.parse(
      projectHostSessionRuntimeCapabilities(capabilities)
    )
  }
  if (args.operation === 'snapshot') {
    const payload = MobileWebSessionSnapshotPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('session.tabs.list', {
      worktree: `id:${hostWorkspaceId}`
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return mobileWebSessionSnapshot(
      response.result,
      hostWorkspaceId,
      payload.workspaceId,
      args.browserAuthority,
      args.nativeChatAuthority
    )
  }
  if (args.operation === 'agentOptions') {
    const payload = MobileWebSessionAgentOptionsPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const options = await loadMobileNewTabAgentOptions({
      client: args.client,
      worktreeId: hostWorkspaceId
    })
    return MobileWebSessionAgentOptionsResultSchema.parse({
      agents: options.map((option) => option.agent)
    })
  }
  if (args.operation === 'activate') {
    const payload = MobileWebSessionTabActionPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('session.tabs.activate', {
      worktree: `id:${hostWorkspaceId}`,
      tabId: args.browserAuthority.hostTabId(hostWorkspaceId, payload.tabId),
      notifyClients: false,
      navigation: 'caller'
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return mobileWebSessionSnapshot(
      response.result,
      hostWorkspaceId,
      payload.workspaceId,
      args.browserAuthority,
      args.nativeChatAuthority
    )
  }
  if (args.operation === 'create') {
    const payload = MobileWebSessionCreatePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('session.tabs.createTerminal', {
      worktree: `id:${hostWorkspaceId}`,
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: args.requestId
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeCreateResult(response.result, payload.workspaceId)
  }
  if (args.operation === 'createAgent') {
    const payload = MobileWebSessionCreateAgentPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const options = await loadMobileNewTabAgentOptions({
      client: args.client,
      worktreeId: hostWorkspaceId
    })
    const selectedAgent = options.find((option) => option.agent === payload.agent)
    if (!selectedAgent) {
      throw new MobileWebBrokerError('invalid_request')
    }
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    const response = await args.client.sendRequest('session.tabs.createTerminal', {
      worktree: `id:${hostWorkspaceId}`,
      agent: selectedAgent.agent,
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: args.requestId
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeCreateResult(response.result, payload.workspaceId)
  }
  if (args.operation === 'createBrowser') {
    const payload = MobileWebSessionBrowserCreatePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const url = isMobileWebBrowserFileUrl(payload.url)
      ? await confineMobileWebBrowserFileUrl({
          url: payload.url,
          hostWorkspaceId,
          client: args.client
        })
      : payload.url
    const response = await args.client.sendRequest('browser.tabCreate', {
      worktree: `id:${hostWorkspaceId}`,
      url,
      activate: true
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeBrowserCreateResult(
      response.result,
      payload.workspaceId,
      hostWorkspaceId,
      args.browserAuthority
    )
  }
  if (args.operation === 'close') {
    const payload = MobileWebSessionTabActionPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('session.tabs.close', {
      worktree: `id:${hostWorkspaceId}`,
      tabId: args.browserAuthority.hostTabId(hostWorkspaceId, payload.tabId),
      reason: 'user'
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeCloseResult(response.result, payload.workspaceId, payload.tabId)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function sanitizeBrowserCreateResult(
  result: unknown,
  workspaceId: string,
  hostWorkspaceId: string,
  browserAuthority: MobileWebBrowserAuthority
): MobileWebSessionBrowserCreateResult {
  if (!isRecord(result) || typeof result.browserPageId !== 'string') {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSessionBrowserCreateResultSchema.safeParse({
    workspaceId,
    browserPageId: browserAuthority.register(hostWorkspaceId, result.browserPageId)
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function sanitizeCreateResult(result: unknown, workspaceId: string): MobileWebSessionCreateResult {
  if (
    !isRecord(result) ||
    !isRecord(result.tab) ||
    result.tab.type !== 'terminal' ||
    typeof result.tab.id !== 'string'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSessionCreateResultSchema.safeParse({
    workspaceId,
    tabId: result.tab.id,
    created: true
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function sanitizeCloseResult(
  result: unknown,
  workspaceId: string,
  tabId: string
): MobileWebSessionCloseResult {
  if (!isRecord(result) || result.closed !== true) {
    throw new MobileWebBrokerError('host_error')
  }
  const refused = result.refused === true
  const refusalReason =
    refused && isCloseRefusalReason(result.refusalReason) ? result.refusalReason : null
  if (refused && refusalReason === null) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSessionCloseResultSchema.safeParse({
    workspaceId,
    tabId,
    outcome: refused ? 'refused' : 'closed',
    refusalReason
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function isCloseRefusalReason(value: unknown): value is (typeof CLOSE_REFUSAL_REASONS)[number] {
  return CLOSE_REFUSAL_REASONS.some((reason) => reason === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
