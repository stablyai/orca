import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const { OrcaRuntimeService, electronMocks } = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../orca-runtime-test-fixtures.spec')

const name = { agent: 'codex' as const, sessionId: 'session-1', title: 'Saved task' }
const surface: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: `host-tab::${HEADLESS_LEAF_ID}`,
  parentTabId: 'host-tab',
  leafId: HEADLESS_LEAF_ID,
  ptyId: 'serve-retained-pty',
  title: 'Codex',
  aiVaultTitle: name,
  resolvesSessionTitle: true,
  isActive: true
}

describe.each([false, true])('session title publisher, main layout=%s', (isMain) => {
  beforeEach(() => {
    layoutOwner.isMain = isMain
    vi.useFakeTimers()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
  })
  afterEach(() => vi.useRealTimers())

  function host() {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const saved = session.tabsByWorktree[TEST_WORKTREE_ID][0]
    saved.ptyId = surface.ptyId!
    saved.aiVaultTitle = name
    session.terminalLayoutsByTabId['host-tab'] = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: surface.ptyId!
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    runtime.registerPty(surface.ptyId!, TEST_WORKTREE_ID, null, {
      tabId: surface.parentTabId,
      leafId: surface.leafId
    })
    runtime.attachWindow(1)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((frame) => events.push(frame))
    function publish(
      windowId: number,
      version: number,
      rows: RuntimeMobileSessionTerminalTab[] = [surface],
      includeWorktree = true,
      generation = `renderer-${windowId}`
    ) {
      runtime.syncWindowGraph(windowId, {
        rendererGeneration: generation,
        tabs: [],
        leaves: [],
        mobileSessionTabs: includeWorktree
          ? [
              {
                worktree: TEST_WORKTREE_ID,
                publicationEpoch: generation,
                snapshotVersion: version,
                activeGroupId: null,
                activeTabId: rows[0]?.id ?? null,
                activeTabType: rows.length ? 'terminal' : null,
                tabs: rows
              }
            ]
          : []
      })
    }
    async function latest() {
      await vi.advanceTimersByTimeAsync(100)
      const frame = events.findLast((event) => event.worktree === TEST_WORKTREE_ID)!
      expect(frame).toBeDefined()
      expect(frame.tabs).toEqual([expect.objectContaining({ id: surface.id })])
      return frame
    }
    return { runtime, events, unsubscribe, publish, latest }
  }

  it('revokes authoritative null and publishes a newer terminal-only frame when its window closes', async () => {
    const h = host()
    try {
      h.publish(1, 1, [{ ...surface, aiVaultTitle: null }])
      const before = await h.latest()
      expect(before.tabs[0]).toMatchObject({ resolvesSessionTitle: true, aiVaultTitle: null })
      h.events.length = 0
      // Window destruction precedes main's close callback.
      electronMocks.BrowserWindow.fromId.mockReturnValue(null)
      h.runtime.markGraphUnavailable(1)
      const after = await h.latest()
      expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
      expect(after.tabs[0]).not.toHaveProperty('resolvesSessionTitle')
      expect(after.tabs[0]).not.toHaveProperty('aiVaultTitle', null)
    } finally {
      h.unsubscribe()
    }
  })

  it.each(['window', 'renderer'])(
    'requires a successor %s to publish the surface before owning its retained name',
    async (successor) => {
      const h = host()
      try {
        h.publish(1, 1)
        expect((await h.latest()).tabs[0]).toHaveProperty('resolvesSessionTitle', true)
        const windowId = successor === 'window' ? 2 : 1
        if (successor === 'window') {
          h.runtime.markGraphUnavailable(1)
          h.runtime.attachWindow(windowId)
        } else {
          h.runtime.markRendererReloading(1)
          expect((await h.latest()).tabs[0]).not.toHaveProperty('resolvesSessionTitle')
        }
        h.publish(windowId, 1, [], true, 'successor-renderer')
        const retained = await h.latest()
        expect(retained.tabs[0]).not.toHaveProperty('resolvesSessionTitle')
        expect(retained.tabs[0]).toHaveProperty('aiVaultTitle', name)
        h.publish(windowId, 2, [surface], true, 'successor-renderer')
        expect((await h.latest()).tabs[0]).toHaveProperty('resolvesSessionTitle', true)
      } finally {
        h.unsubscribe()
      }
    }
  )

  it.each([true, false])(
    'revokes an omitted retained surface when workspace remains=%s',
    async (includeWorktree) => {
      const h = host()
      try {
        h.publish(1, 1)
        const before = await h.latest()
        expect(before.tabs[0]).toHaveProperty('resolvesSessionTitle', true)
        h.events.length = 0
        h.publish(1, 2, [], includeWorktree)
        const after = await h.latest()
        expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
        expect(after.tabs[0]).not.toHaveProperty('resolvesSessionTitle')
        expect(after.tabs[0]).toHaveProperty('aiVaultTitle', name)
      } finally {
        h.unsubscribe()
      }
    }
  )
})
