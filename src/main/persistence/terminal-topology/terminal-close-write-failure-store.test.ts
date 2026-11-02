import { expect, it, vi } from 'vitest'
import {
  admitRuntimeSpawnPane,
  fixture
} from '../loading-store/profile-state-delayed-authority-fixture'

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

async function openWithTab() {
  const opened = await fixture()
  await admitRuntimeSpawnPane(opened.store, pane)
  const tabIds = (session: { tabsByWorktree?: Record<string, { id: string }[]> }) =>
    (session.tabsByWorktree?.[pane.worktreeId] ?? []).map((tab) => tab.id)
  return {
    ...opened,
    liveTabIds: () => tabIds(opened.store.getWorkspaceSession()),
    savedTabIds: () => tabIds(opened.readState().workspaceSession ?? {})
  }
}

it('keeps a tab closed when its profile write fails, and saves it on a later write', async () => {
  const { store, authority, liveTabIds, savedTabIds } = await openWithTab()
  expect(savedTabIds()).toContain(pane.tabId)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  authority.failNextWrite()

  const reply = await store.applyLayoutCommand({
    type: 'closeTabs',
    workspace: pane.worktreeId,
    tabIds: [pane.tabId]
  })

  expect(reply.ok).toBe(true)
  expect(liveTabIds()).not.toContain(pane.tabId)
  expect(savedTabIds()).toContain(pane.tabId)
  await vi.waitFor(() => expect(savedTabIds()).not.toContain(pane.tabId), { timeout: 5000 })
})

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

it('refuses a close once profile writes are frozen, and changes nothing', async () => {
  const { store, liveTabIds } = await openWithTab()
  await store.freezeWritesAsync()

  await expect(
    store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: pane.worktreeId,
      tabIds: [pane.tabId]
    })
  ).rejects.toThrow('finalized')
  expect(liveTabIds()).toContain(pane.tabId)
})
