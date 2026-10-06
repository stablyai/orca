import { beforeEach, expect, it, vi } from 'vitest'

const { invoke, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on, removeListener } }))
import { sshApi } from './api/ssh-bridge'

beforeEach(() => {
  invoke.mockReset()
  on.mockReset()
  removeListener.mockReset()
})

it('admits only hidden authority records from the main snapshot', async () => {
  const authority = {
    targetId: 'runtime-ssh-fixture',
    connectionGeneration: Number.MAX_SAFE_INTEGER
  }
  invoke.mockResolvedValue([authority, { targetId: 'ssh-user', connectionGeneration: 3 }, {}])
  expect(await sshApi.listRuntimeOwnedAuthorities()).toEqual([authority])
  expect(invoke).toHaveBeenCalledWith('ssh:listRuntimeOwnedAuthorities')
  invoke.mockResolvedValue({})
  await expect(sshApi.listRuntimeOwnedAuthorities()).rejects.toThrow(
    'Invalid runtime-owned SSH authority snapshot'
  )
})

it('forwards validated authority and revocation pushes and removes its listener', () => {
  const receive = vi.fn()
  const unsubscribe = sshApi.onRuntimeOwnedAuthorityChanged(receive)
  const listener = on.mock.calls.find(
    ([channel]) => channel === 'ssh:runtime-owned-authority-changed'
  )?.[1]
  if (typeof listener !== 'function') {
    throw new Error('Missing private authority listener')
  }
  const authority = { targetId: 'runtime-ssh-fixture', connectionGeneration: 3 }
  listener({}, authority)
  listener({}, { ...authority, connectionGeneration: null })
  listener({}, { ...authority, connectionGeneration: -1 })
  listener({}, { targetId: 'ssh-user', connectionGeneration: 3 })
  expect(receive.mock.calls).toEqual([[authority], [{ ...authority, connectionGeneration: null }]])
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith('ssh:runtime-owned-authority-changed', listener)
})
