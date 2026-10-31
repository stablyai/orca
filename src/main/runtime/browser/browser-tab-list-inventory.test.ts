import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { BrowserTabListResult } from '../../../shared/runtime-types'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { RuntimeBrowserTabCatalog } from './browser-tab-catalog'
import { RuntimeBrowserTabQueries } from './browser-tab-queries'
import { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { ServeBrowserTabs } from '../serve-browser-tabs'

vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../../browser/doc-preview-guest-policy', () => ({
  onWorkspaceDocGuestRegistered: vi.fn()
}))
vi.mock('../../browser/browser-manager', () => ({
  browserManager: { getWebContentsIdByTabId: () => new Map() },
  browserCertificateTrustController: {}
}))
vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: () => ({ id: 'default', label: 'Default' })
  }
}))

function createInventory() {
  const pages = new RuntimeBrowserPageRegistry()
  const send = vi.fn()
  const serveBrowserTabs = new ServeBrowserTabs({
    backend: () => null,
    livePageIds: () => new Set(),
    savedWorktreeIds: () => ['repo::/checkout', 'folder:notes'],
    session: () => null,
    hostId: () => 'local',
    save: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real query/target/catalog path only reads these guest bridge members.
  const bridge = {
    getRegisteredTabs: () => new Map(),
    tabList: (): BrowserTabListResult => ({ tabs: [] })
  } as unknown as AgentBrowserBridge
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the host boundary used by the real inventory and activation path.
  const host = {
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => pages,
    resolveBrowserWorkspace: async (selector: string) => {
      if (selector === 'id:missing') {
        throw new Error('workspace_not_found')
      }
      return { id: selector.replace(/^id:/, '') }
    },
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    getAuthoritativeWindow: () => ({ webContents: { send } }),
    serveBrowserTabs
  } as unknown as RuntimeBrowserCommandHost
  const targets = new RuntimeBrowserCommandTargets(host)
  const catalog = new RuntimeBrowserTabCatalog(host, targets)
  return { queries: new RuntimeBrowserTabQueries(host, targets, catalog), pages, send }
}

function publishPage(pages: RuntimeBrowserPageRegistry, workspaceId: string) {
  pages.publishClientPage({
    browserPageId: `page-${workspaceId}`,
    workspaceId,
    browserProfileId: 'default',
    executionHostKey: 'native:server:1',
    placement: {
      kind: 'client',
      browserHostClientId: 'desktop',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    },
    url: 'about:blank',
    loading: false,
    active: true
  })
}

async function readWithinBudget(read: Promise<BrowserTabListResult>) {
  const result = Promise.race([
    read,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))
  ])
  await vi.advanceTimersByTimeAsync(3_000)
  return result
}

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
})

describe('browser tab inventory without browser activation', () => {
  it.each([undefined, 'id:repo::/checkout', 'id:folder:notes'])(
    'returns an empty inventory within the CLI budget for %s',
    async (worktree) => {
      vi.useFakeTimers()
      const { queries, send } = createInventory()

      expect(await readWithinBudget(queries.browserTabList({ worktree }))).toEqual({ tabs: [] })
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('lists client pages and keeps folder scope without waking an empty desktop browser', async () => {
    vi.useFakeTimers()
    const { queries, pages, send } = createInventory()
    publishPage(pages, 'folder:notes')
    publishPage(pages, 'repo::/checkout')

    expect(await readWithinBudget(queries.browserTabList({}))).toMatchObject({
      tabs: [
        { browserPageId: 'page-folder:notes', index: 0, active: false },
        { browserPageId: 'page-repo::/checkout', index: 1, active: true }
      ]
    })
    expect(
      await readWithinBudget(queries.browserTabList({ worktree: 'id:folder:notes' }))
    ).toMatchObject({
      tabs: [{ browserPageId: 'page-folder:notes', index: 0, active: true }]
    })
    await expect(queries.browserTabList({ worktree: 'id:missing' })).rejects.toThrow(
      'workspace_not_found'
    )
    expect(send).not.toHaveBeenCalled()
  })
})
