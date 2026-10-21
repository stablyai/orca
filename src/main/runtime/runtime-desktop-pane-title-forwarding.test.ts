import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { electronMocks, OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'

const SPLIT_ROOT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
  second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
}
const SINGLE_ROOT: TerminalPaneLayoutNode = { type: 'leaf', leafId: HEADLESS_LEAF_ID }

// #30386: a desktop host's window owns its layout, so a client's pane rename must reach the window.
function desktopHostRuntime() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window routing only checks that the mocked desktop window is not destroyed.
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements every method these paths call; it is the shared runtime spec fixture.
  const runtime = new OrcaRuntimeService(runtimeStore as never)
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
  return { setPaneTitle, renameTerminal, renamePanes, savedLayout, before }
}

describe('client pane names on a host with its own desktop window', () => {
  it('passes each pane name, and each cleared one, to the window without renaming the tab', async () => {
    const { setPaneTitle, renameTerminal, renamePanes, savedLayout, before } = desktopHostRuntime()

    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: ' server ' })

    expect(setPaneTitle.mock.calls).toEqual([
      ['host-tab', HEADLESS_LEAF_ID, 'server'],
      ['host-tab', HEADLESS_SECOND_LEAF_ID, null]
    ])
    expect(renameTerminal).not.toHaveBeenCalled()
    // The window saves what it shows; main must not write over the window's layout.
    expect(savedLayout()).toEqual(before)
  })

  it('passes on only the panes the client renamed', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'server' }, [HEADLESS_SECOND_LEAF_ID])

    expect(setPaneTitle.mock.calls).toEqual([['host-tab', HEADLESS_SECOND_LEAF_ID, null]])
  })

  it('ignores a resent title map, as an older client sends on every divider drag', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    // Its map can predate a name the host set since, so it must not revert that name.
    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'stale' }, [])

    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('sends nothing when the client left titles out, which means unchanged', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    await renamePanes(SPLIT_ROOT, undefined)

    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('fails the call when the window cannot take the name, so the client retries', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()
    setPaneTitle.mockReturnValue(false)

    await expect(renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'server' })).rejects.toThrow(
      'runtime_unavailable'
    )
  })

  it("never turns the tab's own name into a single pane's name", async () => {
    const { setPaneTitle, renameTerminal, renamePanes } = desktopHostRuntime()

    await renamePanes(SINGLE_ROOT, { [HEADLESS_LEAF_ID]: 'Persisted Terminal' })

    expect(setPaneTitle).not.toHaveBeenCalled()
    expect(renameTerminal).not.toHaveBeenCalled()
  })
})
