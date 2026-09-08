import { vi, type Mock } from 'vitest'
import type { RpcContext } from '../core'
export function nativeChatPageFixture(): {
  context: RpcContext
  scope: { worktree: string; tabId: string; sessionId: string }
  listMobileSessionTabs: Mock
  tab: Record<string, unknown>
} {
  const tab = {
    id: 'tab',
    type: 'terminal',
    terminal: 'host-terminal',
    agentStatus: {
      agentType: 'codex',
      providerSession: { id: 'provider-session', transcriptPath: '/private/transcript' }
    }
  }
  const listMobileSessionTabs = vi.fn().mockResolvedValue({
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    tabs: [tab]
  })
  const context = {
    connectionId: 'connection',
    clientId: 'authenticated-device-token',
    pairedDeviceId: 'device',
    runtime: { listMobileSessionTabs, registerSubscriptionCleanup: vi.fn() }
  } as unknown as RpcContext
  const scope = { worktree: 'id:host-workspace', tabId: 'tab', sessionId: 'provider-session' }
  return { context, scope, listMobileSessionTabs, tab }
}
