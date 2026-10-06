import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'restart-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'old',
  incarnationId: 'old-incarnation'
}

it.each([undefined, 'ssh:restart'])(
  'durably retires only the process binding on %s',
  async (hostId) => {
    const { store, readState } = await fixture()
    await store.persistPtyBinding(binding, hostId)
    const before = structuredClone(store.getWorkspaceSession(hostId))
    expect(await store.retirePtyBinding(binding, hostId)).toBe(true)
    const retired = store.getWorkspaceSession(hostId)
    expect(retired.terminalLayoutsByTabId[binding.tabId]).toEqual({
      ...before.terminalLayoutsByTabId[binding.tabId],
      ptyIdsByLeafId: {}
    })
    expect(retired.tabsByWorktree[binding.worktreeId]).toEqual(
      before.tabsByWorktree[binding.worktreeId].map((tab) =>
        tab.id === binding.tabId ? { ...tab, ptyId: null } : tab
      )
    )
    const durable = hostId
      ? readState().workspaceSessionsByHostId?.[hostId]
      : readState().workspaceSession
    expect(durable?.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({})
    await store.persistPtyBinding(
      { ...binding, ptyId: 'new', incarnationId: 'new-incarnation' },
      hostId
    )
    expect(await store.retirePtyBinding(binding, hostId)).toBe(false)
    expect(
      store.getWorkspaceSession(hostId).terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId?.[
        binding.leafId
      ]
    ).toBe('new')
  }
)

it('clears the stopped id whatever incarnation the binding carries', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding({ ...binding, incarnationId: 'republished-incarnation' })
  expect(await store.retirePtyBinding(binding)).toBe(true)
  expect(store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual(
    {}
  )
})

it('restores the old binding after a known save failure and allows another attempt', async () => {
  const { store, authority } = await fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await store.persistPtyBinding(binding)
  const gate = authority.pause()
  const rejected = expect(store.retirePtyBinding(binding)).rejects.toThrow('disk refused')
  await gate.started.promise
  gate.finish.reject(
    new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
  )
  await rejected
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId?.[
      binding.leafId
    ]
  ).toBe('old')
  expect(await store.retirePtyBinding(binding)).toBe(true)
})
