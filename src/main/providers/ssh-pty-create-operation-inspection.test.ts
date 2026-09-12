import { expect, it, vi } from 'vitest'
import { inspectSshPtyCreateOperation } from './ssh-pty-create-operation-inspection'

const operationId = 'a'.repeat(43)
const recorded = {
  version: 1,
  operationId,
  outcome: 'recorded',
  terminalId: 'terminal',
  incarnationId: 'incarnation'
}
function fixture() {
  const requestHostRpc = vi
    .fn()
    .mockResolvedValueOnce({ agentSessionCreateOperationInspectionVersion: 1 })
    .mockResolvedValueOnce(recorded)
  const controller = new AbortController()
  const assertCurrent = vi.fn()
  const run = () =>
    inspectSshPtyCreateOperation({
      provider: { requestHostRpc },
      operationId,
      signal: controller.signal,
      assertCurrent
    })
  return { requestHostRpc, controller, assertCurrent, run }
}

it('negotiates inspection before returning an exact operation observation without replaying creation', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(recorded)
  expect(f.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
    'pty.getCapabilities',
    'pty.inspectCreateOperation'
  ])
  expect(f.requestHostRpc).toHaveBeenLastCalledWith(
    'pty.inspectCreateOperation',
    {
      agentSessionCreateOperationId: operationId
    },
    { signal: f.controller.signal, timeoutMs: 5_000 }
  )
  expect(f.assertCurrent).toHaveBeenCalledTimes(3)
})

it.each([null, {}, { agentSessionCreateOperationInspectionVersion: 2 }])(
  'refuses unsupported capability %j without issuing inspection',
  async (capability) => {
    const f = fixture()
    f.requestHostRpc.mockReset().mockResolvedValue(capability)
    await expect(f.run()).rejects.toThrow('inspection_unsupported')
    expect(f.requestHostRpc).toHaveBeenCalledOnce()
  }
)

it.each([
  { ...recorded, operationId: 'b'.repeat(43) },
  { ...recorded, version: 2 },
  { ...recorded, terminalId: '' },
  { ...recorded, incarnationId: null },
  { ...recorded, outcome: 'live' }
])('rejects malformed or unbound historical evidence %j', async (result) => {
  const f = fixture()
  f.requestHostRpc
    .mockReset()
    .mockResolvedValueOnce({ agentSessionCreateOperationInspectionVersion: 1 })
    .mockResolvedValueOnce(result)
  await expect(f.run()).rejects.toThrow('inspection_')
})

it('retains unverifiable evidence without treating it as absent or exited', async () => {
  const f = fixture()
  const result = { version: 1, operationId, outcome: 'unverifiable' }
  f.requestHostRpc
    .mockReset()
    .mockResolvedValueOnce({ agentSessionCreateOperationInspectionVersion: 1 })
    .mockResolvedValueOnce(result)
  expect(await f.run()).toEqual(result)
})

it.each([2, 3])('refuses changed authority after awaited step %s', async (step) => {
  const f = fixture()
  f.assertCurrent.mockImplementation(() => {
    if (f.assertCurrent.mock.calls.length === step) {
      throw new Error('provider replaced')
    }
  })
  await expect(f.run()).rejects.toThrow('provider replaced')
  expect(f.requestHostRpc).toHaveBeenCalledTimes(step - 1)
})

it('does not dispatch for an aborted caller', async () => {
  const f = fixture()
  f.controller.abort()
  await expect(f.run()).rejects.toThrow()
  expect(f.requestHostRpc).not.toHaveBeenCalled()
})
