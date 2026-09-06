import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebHostNativeChatBinding,
  MobileWebNativeChatAuthority
} from './mobile-web-native-chat-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function resolveFreshMobileWebNativeChatBinding(args: {
  client: RpcClient
  hostWorkspaceId: string
  sessionId: string
  nativeChatAuthority: MobileWebNativeChatAuthority
  requireTerminal?: boolean
}): Promise<Readonly<MobileWebHostNativeChatBinding>> {
  const binding = args.nativeChatAuthority.resolve(args.hostWorkspaceId, args.sessionId)
  const response = await args.client.sendRequest('session.tabs.list', {
    worktree: `id:${args.hostWorkspaceId}`
  })
  const tab =
    response.ok && isRecord(response.result) && Array.isArray(response.result.tabs)
      ? response.result.tabs.find(
          (value) => isRecord(value) && value.type === 'terminal' && value.id === binding.hostTabId
        )
      : undefined
  // Why not revoke when the host reports no agent status: an unreachable SSH host strips it from a
  // terminal that still exists, and loss of contact is never evidence the session is gone. Only a
  // vanished tab, a different terminal, or a tab rebound to another session ends the grant.
  const gone =
    tab === undefined ||
    !isSameTerminal(tab, binding) ||
    (hasProviderSession(tab) && !isCurrentBinding(tab, binding))
  if (gone || (args.requireTerminal && !binding.hostTerminalId)) {
    args.nativeChatAuthority.revoke(args.sessionId)
    throw new MobileWebBrokerError('not_found')
  }
  args.nativeChatAuthority.assertBinding(args.hostWorkspaceId, args.sessionId, binding)
  return args.nativeChatAuthority.resolve(args.hostWorkspaceId, args.sessionId)
}

export function resolveFreshMobileWebNativeChatPageBinding(
  args: {
    client: RpcClient
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  pageWorkspaceId: string,
  sessionId: string,
  requireTerminal = false
) {
  return resolveFreshMobileWebNativeChatBinding({
    client: args.client,
    hostWorkspaceId: args.workspaceAuthority.hostWorkspaceId(pageWorkspaceId),
    sessionId,
    nativeChatAuthority: args.nativeChatAuthority,
    requireTerminal
  })
}

export function assertCurrentMobileWebNativeChatPageBinding(
  args: {
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  pageWorkspaceId: string,
  sessionId: string,
  binding: Readonly<MobileWebHostNativeChatBinding>
): void {
  args.workspaceAuthority.assertHostWorkspaceBinding(pageWorkspaceId, binding.hostWorkspaceId)
  args.nativeChatAuthority.assertBinding(binding.hostWorkspaceId, sessionId, binding)
}

function hasProviderSession(value: unknown): boolean {
  return (
    isRecord(value) && isRecord(value.agentStatus) && isRecord(value.agentStatus.providerSession)
  )
}

function isSameTerminal(
  value: unknown,
  binding: Readonly<MobileWebHostNativeChatBinding>
): boolean {
  return (
    isRecord(value) &&
    (typeof value.terminal === 'string' ? value.terminal : null) === binding.hostTerminalId
  )
}

function isCurrentBinding(
  value: unknown,
  binding: Readonly<MobileWebHostNativeChatBinding>
): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.agentStatus) ||
    !isRecord(value.agentStatus.providerSession)
  ) {
    return false
  }
  const agent =
    typeof value.agentStatus.agentType === 'string'
      ? value.agentStatus.agentType
      : typeof value.launchAgent === 'string'
        ? value.launchAgent
        : null
  const transcriptPath = value.agentStatus.providerSession.transcriptPath
  return (
    agent === binding.agent &&
    value.agentStatus.providerSession.id === binding.providerSessionId &&
    (typeof transcriptPath === 'string' ? transcriptPath : undefined) === binding.transcriptPath &&
    (typeof value.terminal === 'string' ? value.terminal : null) === binding.hostTerminalId
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
