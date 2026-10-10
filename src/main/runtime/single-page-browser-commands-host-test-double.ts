import { vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RendererPublicationThrottleTarget } from '../window/renderer-publication-throttle'

// The part of the authoritative window a browser stream touches: its renderer's throttle lease target.
export type AuthoritativeWindowDouble = {
  webContents: RendererPublicationThrottleTarget
}

/** A browser command host whose worktree `wt-1` has one registered page, `page-1`. */
export function createSinglePageBrowserCommandsHost(
  window: AuthoritativeWindowDouble | null = null
): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page commands read only these bridge members.
  const bridge = {
    getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
    getActivePageId: vi.fn(() => 'page-1'),
    tabList: vi.fn(() => ({
      tabs: [
        { browserPageId: 'page-1', index: 0, url: 'about:blank', title: 'Browser', active: true }
      ]
    }))
  } as unknown as AgentBrowserBridge
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page commands read only these host members.
  return {
    resolveWorktreeSelector: async () => ({ id: 'wt-1' }),
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAvailableAuthoritativeWindow: vi.fn(() => window),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}
