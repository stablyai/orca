import { vi } from 'vitest'
import type { RpcContext } from '../core'

export function sessionFixture() {
  let snapshot = {
    worktree: 'folder:workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'tab',
    activeTabType: 'terminal',
    workspaceTransportState: 'available',
    tabs: [
      {
        type: 'terminal',
        id: 'tab',
        terminal: 'private-terminal',
        title: 'Codex',
        isActive: true,
        launchAgent: 'codex',
        agentStatus: {
          state: 'waiting',
          agentType: 'codex',
          providerSession: { id: 'provider-session', transcriptPath: '/private/transcript' }
        }
      }
    ] as unknown[]
  }
  const cleanups = new Map<string, () => void>()
  const listeners = new Set<(event: unknown) => void>()
  const controller = new AbortController()
  const runtime = {
    getStatus: () => ({ capabilities: [], floatingWorkspaceEnabled: true }),
    getRuntimeId: () => 'runtime',
    listMobileSessionTabs: vi.fn(async () => snapshot),
    getMobileSessionAgentOptions: vi.fn(async () => ['codex']),
    activateMobileSessionTab: vi.fn(async (_worktree: string, tabId: string) => ({
      ...snapshot,
      activeTabId: tabId
    })),
    closeMobileSessionTab: vi.fn(async () => ({ closed: true })),
    createMobileSessionTerminal: vi.fn(async () => ({
      tab: { id: 'created', terminal: 'private-terminal' }
    })),
    getClientTerminalQuickCommands: vi.fn(() => [] as unknown[]),
    updateClientTerminalQuickCommands: vi.fn(() => [] as unknown[]),
    registerSubscriptionCleanup: vi.fn((key: string, cleanup: () => void) =>
      cleanups.set(key, cleanup)
    ),
    cleanupSubscription: vi.fn((key: string) => {
      const cleanup = cleanups.get(key)
      cleanups.delete(key)
      cleanup?.()
    }),
    onMobileSessionTabsChanged: vi.fn((callback: (event: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    })
  }
  const context = {
    runtime,
    connectionId: 'connection',
    pairedDeviceId: 'device',
    signal: controller.signal
  } as unknown as RpcContext
  const params = { worktree: 'id:folder:workspace', workspaceId: 'opaque-workspace' }
  return {
    runtime,
    context,
    params,
    cleanups,
    controller,
    listeners,
    get snapshot() {
      return snapshot
    },
    setSnapshot(next: typeof snapshot) {
      snapshot = next
    },
    emit() {
      for (const listener of listeners) {
        listener(snapshot)
      }
    }
  }
}
