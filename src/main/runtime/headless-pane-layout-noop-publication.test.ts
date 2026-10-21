/**
 * Perf regression (#26785): every remote pane remount re-sends the layout the host gave it. A
 * headless host used to persist the workspace and republish the whole workspace's tabs to every
 * paired client for each of those identical writes.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'

const REMOUNTS = 20

async function setup() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  // Hydrate the live snapshot the way the first list/subscribe does.
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const published: unknown[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  runtimeStore.setWorkspaceSession.mockClear()
  const update = (args: {
    root?: TerminalPaneLayoutNode | null
    expandedLeafId?: string | null
    titlesByLeafId?: Record<string, string>
    chatLeafId?: string | null
  }) =>
    runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: args.root ?? getSession().terminalLayoutsByTabId['host-tab']!.root,
      expandedLeafId: args.expandedLeafId ?? null,
      ...(args.chatLeafId !== undefined ? { chatLeafId: args.chatLeafId } : {}),
      ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
    })
  return { runtimeStore, getSession, published, update }
}

describe('headless pane layout writes', () => {
  it('neither persists nor republishes a layout the host already has', async () => {
    const { runtimeStore, published, update } = await setup()
    for (let i = 0; i < REMOUNTS; i += 1) {
      await expect(update({})).resolves.toEqual({ updated: true })
    }
    expect(runtimeStore.setWorkspaceSession).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })

  it('persists and publishes once per real change, then dedupes the repeat', async () => {
    const { runtimeStore, getSession, published, update } = await setup()
    await update({ expandedLeafId: HEADLESS_LEAF_ID })
    await update({ expandedLeafId: HEADLESS_LEAF_ID })
    await update({ expandedLeafId: HEADLESS_LEAF_ID, titlesByLeafId: { [HEADLESS_LEAF_ID]: 'a' } })
    await update({ expandedLeafId: HEADLESS_LEAF_ID, titlesByLeafId: { [HEADLESS_LEAF_ID]: 'a' } })
    await update({ expandedLeafId: HEADLESS_LEAF_ID, chatLeafId: HEADLESS_LEAF_ID })
    // An older client that omits the owner leaves it alone, so this is a no-op too.
    await update({ expandedLeafId: HEADLESS_LEAF_ID })
    expect(runtimeStore.setWorkspaceSession).toHaveBeenCalledTimes(3)
    expect(published).toHaveLength(3)
    const layout = getSession().terminalLayoutsByTabId['host-tab']
    expect(layout?.expandedLeafId).toBe(HEADLESS_LEAF_ID)
    expect(layout?.titlesByLeafId).toEqual({ [HEADLESS_LEAF_ID]: 'a' })
    expect(layout?.chatLeafId).toBe(HEADLESS_LEAF_ID)
  })
})
