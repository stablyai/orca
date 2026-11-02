// Phone/paired tab moves use main layout commands for owned workspaces, without asking a window.
import { describe, expect, it, vi } from 'vitest'
import {
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../main-owned-workspace-runtime-fixture'
import { fixture as delayedStoreFixture } from '../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'

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

  /** The client was shown a row main holds no tab for (drawn before main's frame) at the group's front. */
  function showUnheldRow(runtime: unknown): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this member, which OrcaRuntimeService implements.
    const rowsOf = runtime as {
      toMobileSessionTabsResult: (shown: unknown) => {
        tabGroups?: { id: string; tabOrder: string[] }[]
      }
    }
    const real = rowsOf.toMobileSessionTabsResult.bind(runtime)
    rowsOf.toMobileSessionTabsResult = (shown) => {
      const rows = real(shown)
      return {
        ...rows,
        tabGroups: rows.tabGroups?.map((entry) => ({
          ...entry,
          tabOrder: ['diff-1', ...entry.tabOrder]
        }))
      }
    }
  }

  // Main moves rows itself (L280); client-only rows retain no position, but client indices still count them.
  it('moves in a group showing a row main holds no tab for, without asking the window', async () => {
    const { runtime, moveSessionTab, groups, group } = await setup({ window: true })
    showUnheldRow(runtime)

    // Shown: diff-1, terminal, a, b. Index 1 is before the terminal.
    await runtime.moveMobileSessionTab(WT, {
      kind: 'move-to-group',
      tabId: 'b',
      targetGroupId: group,
      index: 1
    })
    expect(groups().map((entry) => entry.tabOrder)).toEqual([['b', TAB_ID, 'a']])

    await runtime.moveMobileSessionTab(WT, {
      kind: 'reorder',
      tabId: 'a',
      targetGroupId: group,
      tabOrder: ['a', 'diff-1', 'b', TAB_ID]
    })
    expect(groups().map((entry) => entry.tabOrder)).toEqual([['a', 'b', TAB_ID]])
    expect(moveSessionTab).not.toHaveBeenCalled()
  })

  it('refuses an order that does not name exactly the rows shown, moving nothing', async () => {
    const { runtime, moveSessionTab, groups, group } = await setup({ window: true })
    showUnheldRow(runtime)
    const before = groups()

    for (const tabOrder of [
      ['a', 'b', TAB_ID],
      ['a', 'other', 'b', TAB_ID],
      ['a', 'diff-1', 'diff-1', 'b', TAB_ID]
    ]) {
      await expect(
        runtime.moveMobileSessionTab(WT, {
          kind: 'reorder',
          tabId: 'a',
          targetGroupId: group,
          tabOrder
        })
      ).rejects.toThrow('invalid_tab_order')
    }
    expect(groups()).toEqual(before)
    expect(moveSessionTab).not.toHaveBeenCalled()
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

  it('a row a queued switch retired splits nothing when the store runs the split', async () => {
    const { store, authority } = await delayedStoreFixture()
    const workspace = 'repo-local::/fixture/local'
    const source = 'tab-local'
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await runtime.applyLayoutCommand({
      type: 'openEditorTab',
      workspace,
      tabId: 'editor',
      fileId: '/fixture/local/e.ts',
      contentType: 'editor',
      file: { filePath: '/fixture/local/e.ts', relativePath: 'e.ts', language: 'typescript' }
    })
    const layout = () =>
      runtime.workspaceLayoutReads.readPartition('local')!.layout.workspaces[workspace]!
    const originalGroup = layout().groups[0]!.id
    // A slow profile write holds the store's queue: the switch queues, then the phone's split of
    // the terminal row the switch retires queues behind it, resolved against the old layout.
    const gate = authority.pause()
    const earlierWrite = runtime.applyLayoutCommand({
      type: 'setTabProps',
      workspace,
      tabId: source,
      color: 'blue'
    })
    await gate.started.promise
    const switching = runtime.applyLayoutCommand({
      type: 'setTabContent',
      workspace,
      tabId: source,
      expectSource: { kind: 'terminal', terminalId: source },
      content: { kind: 'agent-session', sessionId: 'S', agent: 'codex' }
    })
    const moving = runtime.moveMobileSessionTab(`id:${workspace}`, {
      kind: 'split',
      tabId: source,
      targetGroupId: originalGroup,
      splitDirection: 'right'
    })
    gate.finish.resolve()
    await earlierWrite
    expect(await switching).toMatchObject({ ok: true })
    await expect(moving).rejects.toThrow('tab_not_found')
    expect(layout().tabs.find((entry) => entry.id === source)?.kind).toBe('agent-session')
    expect(layout().groups.find((group) => group.tabOrder.includes(source))?.id).toBe(originalGroup)
  })

  it("stops a reorder's later commands once a switch changes a tab it names", async () => {
    const { runtime, groups, group } = await setup()
    await runtime.applyLayoutCommand({
      type: 'moveTab',
      workspace: WORKTREE_ID,
      tabId: TAB_ID,
      toGroupId: group,
      index: 3
    })
    expect(groups()[0]!.tabOrder).toEqual(['a', 'b', TAB_ID])
    const real = runtime.applyLayoutCommand.bind(runtime)
    // The switch lands between the reorder's first and second move.
    const applied = vi
      .spyOn(runtime, 'applyLayoutCommand')
      .mockImplementation(async (command, options) => {
        const reply = await real(command, options)
        if (command.type === 'moveTab' && command.tabId === 'b') {
          await real({
            type: 'setTabContent',
            workspace: WORKTREE_ID,
            tabId: TAB_ID,
            expectSource: { kind: 'terminal', terminalId: TAB_ID },
            content: { kind: 'agent-session', sessionId: 'new-chat', agent: 'codex' }
          })
        }
        return reply
      })
    await expect(
      runtime.moveMobileSessionTab(WT, {
        kind: 'reorder',
        tabId: 'b',
        targetGroupId: group,
        tabOrder: ['b', TAB_ID, 'a']
      })
    ).rejects.toThrow('tab_not_found')
    applied.mockRestore()
    expect(groups()[0]!.tabOrder).toEqual(['b', 'a', TAB_ID])
  })

  it('pins the tab a switch kept by the row its current terminal publishes', async () => {
    const { runtime } = setupMainOwnedWorkspace()
    const tabs = () =>
      runtime.workspaceLayoutReads.readPartition('local')!.layout.workspaces[WORKTREE_ID]!.tabs
    expect(
      await runtime.applyLayoutCommand({
        type: 'setTabContent',
        workspace: WORKTREE_ID,
        tabId: TAB_ID,
        expectSource: { kind: 'terminal', terminalId: TAB_ID },
        content: { kind: 'agent-session', sessionId: 'S', agent: 'codex' }
      })
    ).toMatchObject({ ok: true })
    const leafId = '33333333-3333-4333-8333-333333333333'
    expect(
      await runtime.applyLayoutCommand({
        type: 'setTabContent',
        workspace: WORKTREE_ID,
        tabId: TAB_ID,
        expectSource: { kind: 'agent-session', sessionId: 'S' },
        content: {
          kind: 'terminal',
          terminalId: 'E-new',
          leafId,
          adopt: { ptyId: 'pty-new', recordedPaneKey: `E-new:${leafId}` }
        }
      })
    ).toMatchObject({ ok: true })

    await expect(
      runtime.setMobileSessionTabProps(WT, { tabId: 'E-new', color: 'blue' })
    ).resolves.toEqual({ updated: true })
    expect(tabs().find((tab) => tab.id === TAB_ID)?.color).toBe('blue')
  })
})
