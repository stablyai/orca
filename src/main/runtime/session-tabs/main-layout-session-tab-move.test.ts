// Layout-owner build: a phone's or paired client's tab move in a workspace main owns is main's own
// layout command, window or not; the window is not asked to move it.
import { describe, expect, it, vi } from 'vitest'
import {
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../main-owned-workspace-runtime-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WT = `id:${WORKTREE_ID}`

/** The fixture's terminal tab, then editor tabs a and b, in one group. */
async function setup(opts: { window?: boolean } = {}) {
  const fixture = setupMainOwnedWorkspace()
  for (const name of ['a', 'b']) {
    await fixture.runtime.applyLayoutCommand({
      type: 'openEditorTab',
      workspace: WORKTREE_ID,
      tabId: name,
      fileId: `/workspace/${name}.ts`,
      contentType: 'editor',
      file: {
        filePath: `/workspace/${name}.ts`,
        relativePath: `${name}.ts`,
        language: 'typescript'
      }
    })
  }
  const moveSessionTab = vi.fn()
  if (opts.window) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a move reaches only moveSessionTab on the notifier.
    fixture.runtime.setNotifier({ moveSessionTab } as never)
  }
  const groups = () =>
    fixture.runtime.workspaceLayoutReads.readPartition('local')!.layout.workspaces[WORKTREE_ID]!
      .groups
  return { ...fixture, moveSessionTab, groups, group: groups()[0]!.id }
}

describe("a client's tab move in a workspace main owns", () => {
  it.each([false, true])(
    'reorders in main, window %s, without asking the window',
    async (window) => {
      const { runtime, moveSessionTab, groups, group } = await setup({ window })

      await expect(
        runtime.moveMobileSessionTab(WT, {
          kind: 'reorder',
          tabId: 'b',
          targetGroupId: group,
          tabOrder: ['b', TAB_ID, 'a']
        })
      ).resolves.toEqual({ moved: true })

      expect(groups().map((entry) => entry.tabOrder)).toEqual([['b', TAB_ID, 'a']])
      expect(moveSessionTab).not.toHaveBeenCalled()
      // The client's rows show main's order.
      const listed = await runtime.listMobileSessionTabs(WT)
      expect(listed.tabGroups?.map((entry) => entry.tabOrder)).toEqual([['b', TAB_ID, 'a']])
    }
  )

  it('splits a tab off and moves another into its group at the shown index', async () => {
    const { runtime, groups, group } = await setup({ window: true })

    await runtime.moveMobileSessionTab(WT, {
      kind: 'split',
      tabId: 'b',
      targetGroupId: group,
      splitDirection: 'right'
    })
    const right = groups().find((entry) => entry.id !== group)!.id
    await runtime.moveMobileSessionTab(WT, {
      kind: 'move-to-group',
      tabId: 'a',
      targetGroupId: right,
      index: 0
    })

    expect(groups().map((entry) => entry.tabOrder)).toEqual([[TAB_ID], ['a', 'b']])
  })

  it('leaves a move in a group showing a tab main lacks to the window, as today', async () => {
    const { runtime, moveSessionTab, groups, group } = await setup({ window: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this member, which OrcaRuntimeService implements.
    const rowsOf = runtime as unknown as {
      toMobileSessionTabsResult: (shown: unknown) => {
        tabGroups?: { id: string; tabOrder: string[] }[]
      }
    }
    const real = rowsOf.toMobileSessionTabsResult.bind(runtime)
    // The window shows a diff tab main's layout does not hold.
    rowsOf.toMobileSessionTabsResult = (shown) => {
      const rows = real(shown)
      return {
        ...rows,
        tabGroups: rows.tabGroups?.map((entry) => ({
          ...entry,
          tabOrder: [...entry.tabOrder, 'diff-1']
        }))
      }
    }
    const before = groups()

    await runtime.moveMobileSessionTab(WT, {
      kind: 'move-to-group',
      tabId: 'a',
      targetGroupId: group,
      index: 0
    })

    expect(moveSessionTab).toHaveBeenCalledOnce()
    expect(groups()).toEqual(before)
  })

  it("refuses with today's codes and moves nothing", async () => {
    const { runtime, groups, group } = await setup()
    const before = groups()

    await expect(
      runtime.moveMobileSessionTab(WT, {
        kind: 'move-to-group',
        tabId: 'gone',
        targetGroupId: group
      })
    ).rejects.toThrow('tab_not_found')
    await expect(
      runtime.moveMobileSessionTab(WT, { kind: 'move-to-group', tabId: 'a', targetGroupId: 'gone' })
    ).rejects.toThrow('target_group_not_found')
    await expect(
      runtime.moveMobileSessionTab(WT, {
        kind: 'reorder',
        tabId: 'a',
        targetGroupId: group,
        tabOrder: ['a', 'b']
      })
    ).rejects.toThrow('invalid_tab_order')
    expect(groups()).toEqual(before)
  })
})
