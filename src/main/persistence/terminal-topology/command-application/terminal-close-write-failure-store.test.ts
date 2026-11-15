import { expect, it, vi } from 'vitest'
import {
  admitRuntimeSpawnPane,
  fixture
} from '../../loading-store/profile-writing/profile-state-delayed-authority-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const pane = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

async function openWithTab() {
  const opened = await fixture()
  await admitRuntimeSpawnPane(opened.store, pane)

  return {
    ...opened
  }
}

it('still refuses and rolls back a rename whose profile write fails', async () => {
  const { store, authority } = await openWithTab()
  authority.failNextWrite()

  await expect(
    store.applyLayoutCommand({
      type: 'renameTab',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      kind: 'custom',
      title: 'Renamed'
    })
  ).rejects.toThrow('profile_state_write_failed')
  const tab = store
    .getWorkspaceSession()
    .tabsByWorktree[pane.worktreeId]?.find((row) => row.id === pane.tabId)
  expect(tab?.customTitle ?? null).toBeNull()
})
