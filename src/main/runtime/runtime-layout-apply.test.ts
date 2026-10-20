import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWindowLayoutCommand, type WindowLayoutCommand } from './runtime-layout-apply'
import type { RuntimeStore } from './runtime-store-contract'
import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'

const mocks = vi.hoisted(() => ({
  markAgentLaunchesClosedByUser: vi.fn(),
  frozen: new Set<string>()
}))
vi.mock('../agent-launch/agent-launch-pane-attachment', () => ({
  markAgentLaunchesClosedByUser: mocks.markAgentLaunchesClosedByUser
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-scope-guard', () => ({
  isWslMoveWorkspaceSessionFrozen: (workspaceId: string) => mocks.frozen.has(workspaceId)
}))

const CLOSE = { type: 'closePane', workspace: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' } as const

function storeWith() {
  const applyLayoutCommand = vi.fn(async (): Promise<LayoutApplyOutcome> => ({
    ok: true,
    result: {}
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply path reads only applyLayoutCommand.
  const store = { applyLayoutCommand } as unknown as RuntimeStore
  return { store, applyLayoutCommand }
}

describe('applyWindowLayoutCommand', () => {
  beforeEach(() => {
    mocks.markAgentLaunchesClosedByUser.mockReset()
    mocks.frozen.clear()
  })

  it('closes a pane as the user’s close, in every local or SSH holder', async () => {
    const { store, applyLayoutCommand } = storeWith()

    await applyWindowLayoutCommand(store, () => ['local', 'runtime:env-1', 'ssh:target-1'], CLOSE)

    expect(applyLayoutCommand).toHaveBeenCalledWith({ ...CLOSE, userPaneClose: true }, [
      'local',
      'ssh:target-1'
    ])
    expect(mocks.markAgentLaunchesClosedByUser).toHaveBeenCalledWith('wt-1', {
      kind: 'pane',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('closes a pane automatically with the user-close rules but stops no launch as the user’s', async () => {
    const { store, applyLayoutCommand } = storeWith()

    await applyWindowLayoutCommand(store, () => ['local'], { ...CLOSE, automatic: true })

    expect(applyLayoutCommand).toHaveBeenCalledWith({ ...CLOSE, userPaneClose: true }, ['local'])
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('applies other commands to the routed partition only', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const rename = { ...CLOSE, type: 'renamePane', title: 'Pane' } as const

    await applyWindowLayoutCommand(store, () => ['local', 'ssh:target-1'], rename)

    expect(applyLayoutCommand).toHaveBeenCalledWith(rename, ['local'])
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('records a sleep and a wake in every partition holding the tab, and in no paired server’s', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const wake: WindowLayoutCommand = {
      type: 'wake',
      workspace: 'wt-1',
      tabId: 'tab-1',
      paneKeys: [paneKey]
    }
    const sleep: WindowLayoutCommand = { ...wake, type: 'sleep', records: [] }

    await applyWindowLayoutCommand(store, () => ['local', 'ssh:target-1', 'runtime:env-1'], sleep)
    await applyWindowLayoutCommand(store, () => ['local', 'ssh:target-1'], wake)

    expect(applyLayoutCommand.mock.calls).toEqual([
      [sleep, ['local', 'ssh:target-1']],
      [wake, ['local', 'ssh:target-1']]
    ])
  })

  it('routes a group tree command by its workspace, with no tab to look up', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const hostIdsFor = vi.fn(() => ['ssh:target-1' as const])
    const ratios = {
      type: 'setGroupRatios',
      workspace: 'wt-1',
      groupLayout: { type: 'leaf', groupId: 'g1' }
    } as const

    await applyWindowLayoutCommand(store, hostIdsFor, ratios)

    expect(hostIdsFor).toHaveBeenCalledWith('wt-1', null)
    expect(applyLayoutCommand).toHaveBeenCalledWith(ratios, ['ssh:target-1'])
  })

  it('renames editor files in the workspace’s routed partition, an SSH one too', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const hostIdsFor = vi.fn(() => ['ssh:target-1' as const])
    const rename: WindowLayoutCommand = {
      type: 'renameEditorFiles',
      workspace: 'wt-1',
      renames: [{ fileId: '/a.ts', newFileId: '/b.ts' }]
    }

    await applyWindowLayoutCommand(store, hostIdsFor, rename)

    expect(hostIdsFor).toHaveBeenCalledWith('wt-1', null)
    expect(applyLayoutCommand).toHaveBeenCalledWith(rename, ['ssh:target-1'])
  })

  it('records the window’s tab close in every holder, forced, stopping no terminal', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const close: WindowLayoutCommand = {
      type: 'closeTabs',
      workspace: 'wt-1',
      tabIds: ['tab-1'],
      recordClose: 'user'
    }

    await applyWindowLayoutCommand(store, () => ['local', 'runtime:env-1', 'ssh:target-1'], close)

    expect(applyLayoutCommand).toHaveBeenCalledWith({ ...close, force: true }, [
      'local',
      'ssh:target-1'
    ])
    expect(mocks.markAgentLaunchesClosedByUser).toHaveBeenCalledWith('wt-1', {
      kind: 'tab',
      tabId: 'tab-1'
    })
  })

  it('marks a user close’s launches by the terminal’s id, not its tab-bar entry’s', async () => {
    const { store } = storeWith()
    const session = { unifiedTabs: { 'wt-1': [{ id: 'entry-1', entityId: 'term-1' }] } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only unifiedTabs.
    const withSession = { ...store, getWorkspaceSession: () => session } as unknown as RuntimeStore
    const close: WindowLayoutCommand = {
      type: 'closeTabs',
      workspace: 'wt-1',
      tabIds: ['entry-1'],
      recordClose: 'user'
    }

    await applyWindowLayoutCommand(withSession, () => ['local'], close)

    expect(mocks.markAgentLaunchesClosedByUser).toHaveBeenCalledWith('wt-1', {
      kind: 'tab',
      tabId: 'term-1'
    })
  })

  it('leaves a cleanup close’s launches alone, and a workspace main lacks to today’s close', async () => {
    const { store, applyLayoutCommand } = storeWith()
    applyLayoutCommand.mockResolvedValueOnce({ ok: true, result: { alreadyClosed: true } })
    const close: WindowLayoutCommand = {
      type: 'closeTabs',
      workspace: 'wt-1',
      tabIds: ['tab-1'],
      recordClose: 'cleanup'
    }

    await expect(applyWindowLayoutCommand(store, () => ['local'], close)).resolves.toEqual({
      ok: false,
      code: 'workspace_not_found'
    })
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('moves a dragged-out pane in every holder, and its pane-keyed owners follow', async () => {
    const { store, applyLayoutCommand } = storeWith()
    applyLayoutCommand.mockResolvedValueOnce({
      ok: true,
      result: { tabId: 'tab-new', ptyId: 'pty-1' }
    })
    const session = { unifiedTabs: { 'wt-1': [{ id: 'entry-1', entityId: 'term-1' }] } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only unifiedTabs.
    const withSession = { ...store, getWorkspaceSession: () => session } as unknown as RuntimeStore
    const onPaneMoved = vi.fn()
    const move: WindowLayoutCommand = {
      type: 'movePaneToNewTab',
      workspace: 'wt-1',
      tabId: 'entry-1',
      leafId: 'leaf-1',
      groupId: 'g1',
      // The window cannot name the new tab.
      windowDetach: { ptyId: 'pty-1', tabId: 'tab-window', startupCwd: '/wt/app' }
    }

    await applyWindowLayoutCommand(
      withSession,
      () => ['ssh:t', 'runtime:env-1', 'local'],
      move,
      onPaneMoved
    )

    expect(applyLayoutCommand).toHaveBeenCalledWith(
      { ...move, windowDetach: { ptyId: 'pty-1', startupCwd: '/wt/app' } },
      ['ssh:t', 'local']
    )
    expect(onPaneMoved).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      sourceTabId: 'term-1',
      targetTabId: 'tab-new',
      leafId: 'leaf-1',
      ptyId: 'pty-1'
    })
    applyLayoutCommand.mockResolvedValueOnce({ ok: false, code: 'pty_mismatch' })
    await applyWindowLayoutCommand(withSession, () => ['local'], move, onPaneMoved)
    expect(onPaneMoved).toHaveBeenCalledTimes(1)
    // A committed move still answers ok when re-keying throws.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyLayoutCommand.mockResolvedValueOnce({ ok: true, result: { tabId: 'tab-2', ptyId: null } })
    onPaneMoved.mockImplementationOnce(() => {
      throw new Error('rekey failed')
    })
    await expect(
      applyWindowLayoutCommand(withSession, () => ['local'], move, onPaneMoved)
    ).resolves.toMatchObject({ ok: true })
  })

  it('refuses a tab a paired server routes, touching nothing', async () => {
    const { store, applyLayoutCommand } = storeWith()

    await expect(
      applyWindowLayoutCommand(store, () => ['runtime:env-1', 'local'], CLOSE)
    ).resolves.toEqual({ ok: false, code: 'host_not_owned' })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('moves editor tabs within one partition or across two, and refuses a paired server', async () => {
    const { store, applyLayoutCommand } = storeWith()
    const moveTabToWorkspaceAcrossPartitions = vi.fn(async (): Promise<LayoutApplyOutcome> => ({
      ok: true,
      result: {}
    }))
    store.moveTabToWorkspaceAcrossPartitions = moveTabToWorkspaceAcrossPartitions
    const move: WindowLayoutCommand = {
      type: 'moveTabToWorkspace',
      workspace: 'wt-1',
      toWorkspace: 'wt-2',
      tabs: [{ tabId: 'tab-1', newTabId: 'tab-1', newEntityId: 'file-2' }],
      groupId: 'g2'
    }
    const hostIdsFor = vi.fn((_worktreeId: string, _tabId: string | null) => [
      'ssh:target-1' as const
    ])

    await applyWindowLayoutCommand(store, hostIdsFor, move)
    expect(hostIdsFor.mock.calls).toEqual([
      ['wt-1', null],
      ['wt-2', null]
    ])
    expect(applyLayoutCommand).toHaveBeenCalledWith(move, ['ssh:target-1'])

    applyLayoutCommand.mockClear()
    await applyWindowLayoutCommand(
      store,
      (worktreeId) => [worktreeId === 'wt-1' ? 'local' : 'ssh:target-1'],
      move
    )
    expect(moveTabToWorkspaceAcrossPartitions).toHaveBeenCalledWith(move, 'local', 'ssh:target-1')
    expect(applyLayoutCommand).not.toHaveBeenCalled()

    const partitions = {
      'a paired server': [['local'], ['runtime:env-1'], 'host_not_owned'],
      'an unknown target': [['local'], [], 'host_not_owned']
    } as const
    for (const [from, to, code] of Object.values(partitions)) {
      await expect(
        applyWindowLayoutCommand(
          store,
          (worktreeId) => [...(worktreeId === 'wt-1' ? from : to)],
          move
        )
      ).resolves.toEqual({ ok: false, code })
    }
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })

  it('refuses any command on a workspace a WSL move has paused, writing nothing', async () => {
    const { store, applyLayoutCommand } = storeWith()
    mocks.frozen.add('wt-1')
    const commands: WindowLayoutCommand[] = [
      CLOSE,
      { ...CLOSE, type: 'renamePane', title: 'Pane' },
      { type: 'closeTabs', workspace: 'wt-1', tabIds: ['tab-1'], recordClose: 'user' },
      { type: 'setGroupRatios', workspace: 'wt-1', groupLayout: { type: 'leaf', groupId: 'g-1' } }
    ]

    for (const command of commands) {
      await expect(applyWindowLayoutCommand(store, () => ['local'], command)).resolves.toEqual({
        ok: false,
        code: 'wsl_move_in_progress'
      })
    }
    expect(applyLayoutCommand).not.toHaveBeenCalled()
    expect(mocks.markAgentLaunchesClosedByUser).not.toHaveBeenCalled()
  })

  it('refuses a tab move into a paused workspace, which would drop the moved tab', async () => {
    const { store, applyLayoutCommand } = storeWith()
    mocks.frozen.add('wt-2')
    const move: WindowLayoutCommand = {
      type: 'moveTabToWorkspace',
      workspace: 'wt-1',
      toWorkspace: 'wt-2',
      tabs: [{ tabId: 'tab-1', newTabId: 'tab-2', newEntityId: 'tab-2' }],
      groupId: 'g-2'
    }

    await expect(applyWindowLayoutCommand(store, () => ['local'], move)).resolves.toEqual({
      ok: false,
      code: 'wsl_move_in_progress'
    })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })

  it('applies as before on a workspace no move has paused', async () => {
    const { store, applyLayoutCommand } = storeWith()
    mocks.frozen.add('wt-other')

    await expect(applyWindowLayoutCommand(store, () => ['local'], CLOSE)).resolves.toEqual({
      ok: true,
      result: {}
    })
    expect(applyLayoutCommand).toHaveBeenCalledTimes(1)
  })
})
