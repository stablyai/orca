import { expect, it } from 'vitest'
import { HostActivityReadModel } from './host-activity-read-model'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { agentActivitySubjectKey } from '../../../src/shared/agent-activity-read-state'

const a = {
  paneKey: 'a',
  worktreeId: 'main',
  hostId: 'local',
  latestActivityAt: 100,
  stateStartedAt: 100,
  unread: true
}
const b = { ...a, paneKey: 'b' }
const reply = (result: unknown): RpcResponse => ({
  id: 'test',
  ok: true,
  result,
  _meta: { runtimeId: 'host' }
})

it('applies only the acknowledged activity and rejects an older refresh that finishes afterward', async () => {
  let releaseRead!: (value: RpcResponse) => void
  let reads = 0
  const client = stubRpcClient({
    sendRequest: (method) => {
      if (method === 'ui.setAgentActivityReadState') {
        return Promise.resolve(reply({ ...a, unread: false }))
      }
      reads++
      if (reads > 2) {
        return Promise.resolve(
          reply({
            available: true,
            activities: [
              { ...a, unread: false },
              { ...b, latestActivityAt: 200 }
            ]
          })
        )
      }
      return reads === 1
        ? Promise.resolve(reply({ available: true, activities: [a, b] }))
        : new Promise((resolve) => {
            releaseRead = resolve
          })
    }
  })
  const model = new HostActivityReadModel(client)
  model.setActive(true)
  await model.refresh()
  const old = model.refresh()
  await model.setRead(a, true)
  releaseRead(reply({ available: true, activities: [a, b] }))
  await old
  expect(model.getSnapshot().activities.get(agentActivitySubjectKey(a))?.unread).toBe(false)
  expect(model.getSnapshot().activities.get(agentActivitySubjectKey(b))?.unread).toBe(true)
  await model.refresh()
  expect(model.getSnapshot().activities.get(agentActivitySubjectKey(b))?.latestActivityAt).toBe(200)
  model.setActive(false)
})

it('keeps the unread marker on refusal and ignores replies for an inactive host', async () => {
  let releaseRead!: (value: RpcResponse) => void
  const client = stubRpcClient({
    sendRequest: (method) =>
      method === 'ui.setAgentActivityReadState'
        ? Promise.resolve({
            id: 'test',
            ok: false,
            error: { code: 'forbidden', message: 'refused' },
            _meta: { runtimeId: 'host' }
          })
        : new Promise((resolve) => {
            releaseRead = resolve
          })
  })
  const model = new HostActivityReadModel(client)
  model.setActive(true)
  const first = model.refresh()
  releaseRead(reply({ available: true, activities: [a] }))
  await first
  await expect(model.setRead(a, true)).rejects.toThrow()
  expect(model.getSnapshot().activities.get(agentActivitySubjectKey(a))?.unread).toBe(true)
  const stale = model.refresh()
  model.setActive(false)
  releaseRead(reply({ available: true, activities: [{ ...a, unread: false }] }))
  await stale
  expect(model.getSnapshot().activities.get(agentActivitySubjectKey(a))?.unread).toBe(true)
})

it('distinguishes an unsupported host from a read activity', async () => {
  const client = stubRpcClient({
    sendRequest: async () => ({
      id: 'test',
      ok: false,
      error: { code: 'method_not_found', message: 'unknown' },
      _meta: { runtimeId: 'host' }
    })
  })
  const model = new HostActivityReadModel(client)
  model.setActive(true)
  await model.refresh()
  expect(model.getSnapshot().status).toBe('unsupported')
  expect(model.getSnapshot().activities.size).toBe(0)
  model.setActive(false)
})
