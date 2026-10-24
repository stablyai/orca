import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  fixture,
  admitRuntimeSpawnPane
} from '../loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import {
  captureTerminalSurfaceIdentity,
  type TerminalSurfaceCloseCapture
} from '../../../shared/terminal-tab-close'
import { applyWindowLayoutCommand } from '../../runtime/runtime-layout-apply'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
const pane = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}
const command = {
  type: 'closePane' as const,
  workspace: pane.worktreeId,
  tabId: pane.tabId,
  leafId: pane.leafId
}
async function opened() {
  const opened = await fixture()
  await admitRuntimeSpawnPane(opened.store, pane)
  const identity = captureTerminalSurfaceIdentity(
    opened.store.getWorkspaceSession(),
    pane.worktreeId,
    pane.tabId,
    pane.leafId
  )
  if (!identity) {
    throw new Error('Missing original owner')
  }
  const originalPresentation: TerminalSurfaceCloseCapture = {
    identity,
    holders: [{ hostId: 'local', identity }]
  }
  return { ...opened, originalPresentation }
}

it.each(['successor', 'new holder'] as const)(
  'checks %s at queued admission, preserving membership and future commands',
  async (change) => {
    const { store, authority, originalPresentation } = await opened()
    const pause = authority.pause()
    const preceding = store.runDurableMutation(() => ({ value: undefined }))
    await pause.started.promise
    const closing = applyWindowLayoutCommand(store, () => ['local'], command, undefined, {
      originalPresentation,
      admit: () => true
    })
    // A replacement commits before the close is admitted, after its caller already dispatched it.
    const state = store.getWorkspaceSession()
    if (change === 'new holder') {
      store.setWorkspaceSession(state, 'ssh:new-holder')
    } else {
      store.setWorkspaceSession({
        ...state,
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [pane.worktreeId]: state.tabsByWorktree[pane.worktreeId].map((row) => ({
            ...row,
            generation: (row.generation ?? 0) + 1
          }))
        }
      })
    }
    const refused = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
    pause.finish.resolve()
    await preceding
    await refused
    expect(
      store.getWorkspaceSession().tabsByWorktree[pane.worktreeId].map((row) => row.id)
    ).toContain(pane.tabId)
    await expect(
      store.applyLayoutCommand({
        type: 'renameTab',
        workspace: pane.worktreeId,
        tabId: pane.tabId,
        kind: 'custom',
        title: 'Still usable'
      })
    ).resolves.toMatchObject({ ok: true })
  }
)

it('requires the captured close write, retains the applied removal on failure and reloads its later durable intent', async () => {
  const { store, authority, originalPresentation, readState, directory, path } = await opened()
  authority.failNextWrite()
  await expect(
    applyWindowLayoutCommand(store, () => ['local'], command, undefined, {
      originalPresentation,
      admit: () => true
    })
  ).rejects.toThrow('profile_state_write_failed')
  expect(store.getWorkspaceSession().tabsByWorktree[pane.worktreeId].map((row) => row.id)).toEqual([
    'tab-local'
  ])
  expect(
    readState().workspaceSession.tabsByWorktree[pane.worktreeId].map(
      (row: { id: string }) => row.id
    )
  ).toContain(pane.tabId)
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  const reloaded = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(path, 'coordination-test')
  })
  try {
    expect(
      reloaded.getWorkspaceSession().tabsByWorktree[pane.worktreeId].map((row) => row.id)
    ).toEqual(['tab-local'])
    expect(
      reloaded.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[pane.tabId]
    ).toBeDefined()
  } finally {
    await reloaded.freezeWritesAsync()
  }
})
