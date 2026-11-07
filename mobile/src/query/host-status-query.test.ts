import { expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { hostReadClient } from './host-read-client'
import { connectionHostStatus, sendHostStatusRead } from './host-status-query'

it("a query's read view sees the status its connection already received", async () => {
  const client = createFakeRpcClient({ getLastConnectedAt: () => 1, getGeneration: () => 1 })
  const read = sendHostStatusRead(client)
  client.requests[0].resolve({ id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } })
  await read
  expect(connectionHostStatus(hostReadClient(client))?.status.capabilities).toEqual(['aiVault.v1'])
})
