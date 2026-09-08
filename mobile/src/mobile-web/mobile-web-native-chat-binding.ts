import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export type MobileWebHostNativeChatBinding = {
  hostWorkspaceId: MobileWebHostWorkspaceId
  hostTabId: string
  hostTerminalId: string | null
  agent: string
  providerSessionId: string
  transcriptPath?: string
}

type BindingArgs = {
  client: RpcClient
  isActive?: () => boolean
  workspaceAuthority: MobileWebWorkspaceAuthority
}

/** Finds the host terminal tab whose agent reported `sessionId`. The page addresses chat by the
 *  provider session id, which is what the host publishes in its session snapshot. */
export async function resolveMobileWebNativeChatBinding(
  args: BindingArgs,
  pageWorkspaceId: string,
  sessionId: string,
  requireTerminal = false
): Promise<Readonly<MobileWebHostNativeChatBinding>> {
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(pageWorkspaceId)
  const response = await args.client.sendRequest('session.tabs.list', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (args.isActive?.() === false) {
    throw new MobileWebBrokerError('cancelled')
  }
  if (!response.ok || !isRecord(response.result) || response.result.worktree !== hostWorkspaceId) {
    throw new MobileWebBrokerError('host_error')
  }
  const tabs = response.result.tabs
  if (!Array.isArray(tabs)) {
    throw new MobileWebBrokerError('host_error')
  }
  const binding = tabs
    .flatMap((tab) => nativeChatBinding(tab, hostWorkspaceId))
    .find((candidate) => candidate.providerSessionId === sessionId)
  if (!binding || (requireTerminal && !binding.hostTerminalId)) {
    throw new MobileWebBrokerError('not_found')
  }
  args.workspaceAuthority.assertHostWorkspaceBinding(pageWorkspaceId, hostWorkspaceId)
  return binding
}

/** Re-reads the binding after a host round trip: a replaced terminal must not receive the rest
 *  of a multi-step write. */
export async function assertCurrentMobileWebNativeChatBinding(
  args: BindingArgs,
  pageWorkspaceId: string,
  sessionId: string,
  binding: Readonly<MobileWebHostNativeChatBinding>
): Promise<void> {
  args.workspaceAuthority.assertHostWorkspaceBinding(pageWorkspaceId, binding.hostWorkspaceId)
  const current = await resolveMobileWebNativeChatBinding(args, pageWorkspaceId, sessionId)
  if (JSON.stringify(current) !== JSON.stringify(binding)) {
    throw new MobileWebBrokerError('conflict')
  }
}

function nativeChatBinding(
  value: unknown,
  hostWorkspaceId: MobileWebHostWorkspaceId
): MobileWebHostNativeChatBinding[] {
  if (
    !isRecord(value) ||
    value.type !== 'terminal' ||
    typeof value.id !== 'string' ||
    !value.id ||
    !isRecord(value.agentStatus) ||
    !isRecord(value.agentStatus.providerSession)
  ) {
    return []
  }
  const agent = boundedText(value.agentStatus.agentType) ?? boundedText(value.launchAgent)
  const providerSessionId = boundedText(value.agentStatus.providerSession.id)
  if (!agent || !providerSessionId) {
    return []
  }
  const transcriptPath = boundedText(value.agentStatus.providerSession.transcriptPath, 16 * 1024)
  return [
    {
      hostWorkspaceId,
      hostTabId: value.id,
      hostTerminalId:
        typeof value.terminal === 'string' && value.terminal.length > 0 ? value.terminal : null,
      agent,
      providerSessionId,
      ...(transcriptPath ? { transcriptPath } : {})
    }
  ]
}

function boundedText(value: unknown, maximum = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
