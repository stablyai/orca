import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export async function resolveMobileWebTerminal(
  client: RpcClient,
  hostWorkspaceId: string,
  tabId: string
): Promise<string> {
  return resolveMobileWebTerminalHandle(client, hostWorkspaceId, tabId, false)
}

export async function resolveActiveMobileWebTerminal(
  client: RpcClient,
  hostWorkspaceId: string,
  tabId: string
): Promise<string> {
  return resolveMobileWebTerminalHandle(client, hostWorkspaceId, tabId, true)
}

async function resolveMobileWebTerminalHandle(
  client: RpcClient,
  hostWorkspaceId: string,
  tabId: string,
  requireActive: boolean
): Promise<string> {
  const response = await client.sendRequest('session.tabs.list', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (!response.ok || !isRecord(response.result) || response.result.worktree !== hostWorkspaceId) {
    throw new MobileWebBrokerError('host_error')
  }
  const tabs = response.result.tabs
  if (!Array.isArray(tabs)) {
    throw new MobileWebBrokerError('host_error')
  }
  const tab = tabs.find((value) => isRecord(value) && value.id === tabId)
  if (
    !isRecord(tab) ||
    tab.type !== 'terminal' ||
    tab.status !== 'ready' ||
    typeof tab.terminal !== 'string' ||
    tab.terminal.length < 1 ||
    tab.terminal.length > 256 ||
    (requireActive && (response.result.activeTabId !== tabId || tab.isActive !== true))
  ) {
    throw new MobileWebBrokerError('not_found')
  }
  return tab.terminal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
