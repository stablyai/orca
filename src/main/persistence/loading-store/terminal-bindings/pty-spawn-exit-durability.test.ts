import { expect, it, vi } from 'vitest'
import { fixture } from '../profile-writing/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { registerPersistedPtySpawn } from '../../../ipc/pty/pane/spawn-registration'

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
  ptyId: 'exited-pty',
  incarnationId: 'old-incarnation'
}

it.each(['replacement-pty', binding.ptyId])(
  'preserves a replacement binding to %s while retirement waits',
  async (ptyId) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    await store.persistPtyBinding(binding)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    const gate = authority.pause()
    const replacement = store.persistPtyBinding({
      ...binding,
      ptyId,
      incarnationId: 'new-incarnation'
    })
    await gate.started.promise
    const registration = expect(
      registerPersistedPtySpawn(
        runtime,
        store,
        undefined,
        undefined,
        binding.ptyId,
        binding.worktreeId,
        null,
        binding
      )
    ).rejects.toThrow('agent_session_exited_during_start')
    gate.finish.resolve()
    await Promise.all([replacement, registration])
    const session = readState().workspaceSession
    expect(session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[binding.leafId]).toBe(ptyId)
    expect(session.terminalPtyIncarnationsByPaneKey[`${binding.tabId}:${binding.leafId}`]).toBe(
      'new-incarnation'
    )
  }
)

it('retains the binding when loss of contact supplies no process-exit proof', async () => {
  const { store, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, -1, binding.incarnationId)
  expect(() =>
    registerPersistedPtySpawn(
      runtime,
      store,
      undefined,
      undefined,
      binding.ptyId,
      binding.worktreeId,
      null,
      binding
    )
  ).toThrow('agent_session_exited_during_start')
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
})

it('does not settle rejected registration until its exit cleanup reaches SQLite', async () => {
  const { store, authority, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  const gate = authority.pause()
  let rejected = false
  const cleanup = registerPersistedPtySpawn(
    runtime,
    store,
    undefined,
    undefined,
    binding.ptyId,
    binding.worktreeId,
    null,
    binding
  )
  if (!cleanup) {
    throw new Error('exited registration did not start durable cleanup')
  }
  const pending = cleanup.catch((error: unknown) => {
    rejected = true
    throw error
  })
  const failure = expect(pending).rejects.toThrow('agent_session_exited_during_start')
  await gate.started.promise
  expect(rejected).toBe(false)
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
  gate.finish.resolve()
  await failure
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[
      binding.leafId
    ]
  ).toBeUndefined()
})
