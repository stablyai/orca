import { expect, it, vi } from 'vitest'
import { fixture } from '../profile-writing/profile-state-delayed-authority-fixture'
import { resolvePersistedStablePaneOwner } from '../../../ipc/pty/pane/stable-owner'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
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

function rendererSave(session: WorkspaceSessionState): WorkspaceSessionState {
  const { terminalPtyIncarnationsByPaneKey: _omitted, ...rest } = session
  return structuredClone(rest)
}

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

it('drops the incarnation once a window save binds the pane to another PTY', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding(binding)
  const saved = rendererSave(store.getWorkspaceSession())
  saved.terminalLayoutsByTabId![binding.tabId]!.ptyIdsByLeafId![binding.leafId] =
    'repo-local::/fixture/local@@pane0002'

  store.setWorkspaceSession(saved)

  expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBeUndefined()
})
