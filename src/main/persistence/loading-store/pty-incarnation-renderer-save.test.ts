import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { resolvePersistedStablePaneOwner } from '../../ipc/pty/pane/stable-owner'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'repo-local::/fixture/local@@pane0001',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
const paneKey = `${binding.tabId}:${binding.leafId}`

/** What the window saves: its own view of the session, which never carries incarnations. */
function rendererSave(session: WorkspaceSessionState): WorkspaceSessionState {
  const { terminalPtyIncarnationsByPaneKey: _omitted, ...rest } = session
  return structuredClone(rest)
}

// #30486: a renderer save erased the incarnation, so a restart reattached with no generation proof.
it('keeps the PTY incarnation across a window save that still binds the pane', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding(binding)

  store.setWorkspaceSession(rendererSave(store.getWorkspaceSession()))

  expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual({
    [paneKey]: binding.incarnationId
  })
  expect(resolvePersistedStablePaneOwner(store, paneKey, binding.worktreeId, null)).toMatchObject({
    ptyId: binding.ptyId,
    incarnationId: binding.incarnationId
  })
})

it('keeps other panes incarnations when a save carries only some of them', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding(binding)
  const saved = rendererSave(store.getWorkspaceSession())
  saved.terminalPtyIncarnationsByPaneKey = { 'other-tab:dddddddd-dddd-4ddd-8ddd-dddddddddddd': 'x' }

  store.setWorkspaceSession(saved)

  expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
    binding.incarnationId
  )
})

it('drops the incarnation once a window save binds the pane to another PTY', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding(binding)
  const saved = rendererSave(store.getWorkspaceSession())
  saved.terminalLayoutsByTabId![binding.tabId]!.ptyIdsByLeafId![binding.leafId] =
    'repo-local::/fixture/local@@pane0002'

  store.setWorkspaceSession(saved)

  expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBeUndefined()
})
