import '../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import '../orca-runtime-tests/runtime-test-module-registration.spec'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { createMobileCreateTestNotifier } from '../orca-runtime-tests/orca-runtime-test-scenario-builders.spec'
import '../rpc/dispatcher'
import '../rpc/methods/session-tabs/session-tabs'
import '../rpc/methods/structured-sessions/protocol/structured-agent-session-rpc.test-fixture'
import type { TerminalPaneLayoutNode } from '../../../shared/workspace-layout/terminal-tab-types'

const SPLIT_ROOT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
  second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
}

// #30386: a desktop host's window owns its layout, so a client's pane rename must reach the window.
function desktopHostRuntime() {
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.attachWindow(1)
  const setPaneTitle = vi.fn(() => true)
  const renameTerminal = vi.fn()
  runtime.setNotifier({ ...createMobileCreateTestNotifier(vi.fn()), setPaneTitle, renameTerminal })
  const savedLayout = () => getSession().terminalLayoutsByTabId['host-tab']
  const before = structuredClone(savedLayout())
  const renamePanes = (
    root: TerminalPaneLayoutNode,
    titlesByLeafId: Record<string, string> | undefined,
    renamedLeafIds: string[] = [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID]
  ) =>
    runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root,
      expandedLeafId: null,
      ...(titlesByLeafId ? { titlesByLeafId } : {}),
      renamedLeafIds
    })
  return { runtime, setPaneTitle, renameTerminal, renamePanes, savedLayout, before }
}

describe('client pane names on a host with its own desktop window', () => {
  it('ignores a resent title map, as an older client sends on every divider drag', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    // Its map can predate a name the host set since, so it must not revert that name.
    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'stale' }, [])

    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('fails the call when the window cannot take the name, so the client retries', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()
    setPaneTitle.mockReturnValue(false)

    await expect(renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'server' })).rejects.toThrow(
      'runtime_unavailable'
    )
  })
})
