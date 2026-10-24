import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../loading-store/store'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const on = { workspace: FIXTURE_GIT_WORKTREE_ID }
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function apply(store: Store, command: LayoutCommand) {
  const result = await store.applyLayoutCommand(command)
  expect(result.ok, command.type).toBe(true)
}

async function storeWithSplit(): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pane-last-grid-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  await apply(store, { ...on, type: 'createTerminalTab', tabId: 'tab-1', leafId: LEAF_A })
  await apply(store, {
    ...on,
    type: 'splitPane',
    tabId: 'tab-1',
    leafId: LEAF_A,
    direction: 'vertical',
    newLeafId: LEAF_B
  })
  return { store, directory }
}

describe("a pane's last grid (layout-owner build)", () => {
  it('is stored on its tab layout and survives a restart', async () => {
    const { store, directory } = await storeWithSplit()
    await apply(store, {
      ...on,
      type: 'setPaneGrid',
      tabId: 'tab-1',
      leafId: LEAF_B,
      grid: { cols: 91, rows: 33 }
    })

    const relaunched = await reopenTopologyStore(store, directory)

    expect(
      relaunched.getWorkspaceSession().terminalLayoutsByTabId['tab-1']?.lastGridsByLeafId
    ).toEqual({
      [LEAF_B]: { cols: 91, rows: 33 }
    })
  })

  it('moves with its pane into a new tab', async () => {
    const { store, directory } = await storeWithSplit()
    await apply(store, {
      ...on,
      type: 'setPaneGrid',
      tabId: 'tab-1',
      leafId: LEAF_B,
      grid: { cols: 91, rows: 33 }
    })
    await apply(store, { ...on, type: 'movePaneToNewTab', tabId: 'tab-1', leafId: LEAF_B })

    const layouts = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
      .terminalLayoutsByTabId
    const movedTo = Object.keys(layouts).find((tabId) => tabId !== 'tab-1')
    expect(layouts['tab-1']?.lastGridsByLeafId).toBeUndefined()
    expect(layouts[movedTo!]?.lastGridsByLeafId).toEqual({ [LEAF_B]: { cols: 91, rows: 33 } })
  })

  it("writes only the pane's own tab record", async () => {
    const { store } = await storeWithSplit()
    await apply(store, { ...on, type: 'createTerminalTab', tabId: 'tab-other' })
    const before = store.getWorkspaceSession()
    await apply(store, {
      ...on,
      type: 'setPaneGrid',
      tabId: 'tab-1',
      leafId: LEAF_B,
      grid: { cols: 91, rows: 33 }
    })
    const after = store.getWorkspaceSession()

    expect(after.terminalLayoutsByTabId['tab-other']).toBe(
      before.terminalLayoutsByTabId['tab-other']
    )
    expect(after.unifiedTabs).toBe(before.unifiedTabs)
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
  })

  it('is refused for a pane the tab does not hold', async () => {
    const { store } = await storeWithSplit()
    const result = await store.applyLayoutCommand({
      ...on,
      type: 'setPaneGrid',
      tabId: 'tab-1',
      leafId: '33333333-3333-4333-8333-333333333333',
      grid: { cols: 80, rows: 24 }
    })
    expect(result).toMatchObject({ ok: false })
  })

  it("keeps a grid resized just before quit, written by the quit's flush", async () => {
    const { store, directory } = await storeWithSplit()
    await store.persistPtyBinding({
      worktreeId: FIXTURE_GIT_WORKTREE_ID,
      tabId: 'tab-1',
      leafId: LEAF_B,
      ptyId: 'pty-b'
    })
    const runtime = new OrcaRuntimeService(store)

    // Inside the write burst: nothing written yet when the quit starts.
    runtime.onExternalPtyResize('pty-b', 91, 33)
    await runtime.flushPaneGrids()
    const relaunched = await reopenTopologyStore(store, directory)

    expect(
      relaunched.getWorkspaceSession().terminalLayoutsByTabId['tab-1']?.lastGridsByLeafId
    ).toEqual({ [LEAF_B]: { cols: 91, rows: 33 } })
  })

  it('releases a pane from the terminal it names, and leaves a pane another terminal took', async () => {
    const { store } = await storeWithSplit()
    await store.persistPtyBinding({
      worktreeId: FIXTURE_GIT_WORKTREE_ID,
      tabId: 'tab-1',
      leafId: LEAF_B,
      ptyId: 'pty-b'
    })
    await apply(store, {
      ...on,
      type: 'releasePaneTerminal',
      tabId: 'tab-1',
      leafId: LEAF_B,
      ptyId: 'pty-stale'
    })
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_B]
    ).toBe('pty-b')

    await apply(store, {
      ...on,
      type: 'releasePaneTerminal',
      tabId: 'tab-1',
      leafId: LEAF_B,
      ptyId: 'pty-b'
    })
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_B]
    ).toBeUndefined()
  })
})
