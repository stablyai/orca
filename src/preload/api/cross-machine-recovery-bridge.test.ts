import { expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('electron', () => ({
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
}))

import { crossMachineRecoveryApi } from './cross-machine-recovery-bridge'

it('delivers pickup to main before a cancel issued while the client id is still loading', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'crossMachineRecovery:getClientInstanceId'
      ? new Promise(() => {})
      : Promise.resolve(undefined)
  )
  void crossMachineRecoveryApi.pickup({ operationId: 'op-1', selector: 'a/b', resume: [] })
  await crossMachineRecoveryApi.cancel('op-1')
  expect(invoke.mock.calls).toEqual([
    ['crossMachineRecovery:pickup', { operationId: 'op-1', selector: 'a/b', resume: [] }],
    ['crossMachineRecovery:cancel', { operationId: 'op-1' }]
  ])
})
