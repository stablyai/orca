import { expect, it, vi } from 'vitest'
import type { BotComputerAnswer } from '../../bots/bot-link-host-reads'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../../host-screen/catalog/host-list-queries'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

vi.mock('react-native', () => ({ AppState: {} }))
const reads = vi.hoisted(() => ({ answers: async (): Promise<BotComputerAnswer[]> => [] }))
vi.mock('../../bots/bot-link-host-reads', () => ({
  readBotComputerAnswers: () => reads.answers()
}))
vi.mock('../../bots/bot-group-operations', () => ({
  groupList: { request: async () => ({}), interpret: () => ({ groups: [] }) }
}))

import { homeBotsQuery } from './home-bots-query'

function host() {
  let generation = 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read takes its epoch from these two only; the list reads are mocked.
  const client = {
    getGeneration: () => generation,
    getLastConnectedAt: () => generation * 1000
  } as unknown as RpcClient
  return { client, reconnect: () => (generation += 1) }
}

function read(client: RpcClient) {
  const fetch = homeBotsQuery.fetch
  return createOrcaQueryClient().fetchQuery({
    queryKey: ['home-bots-test'],
    queryFn: () =>
      fetch(client, HOST_LIST_TARGET, NO_HOST_LIST_INPUT, undefined, {
        hostId: 'studio',
        live: false,
        previousFromStore: false
      })
  })
}

it('reads again on the newest connection, however many reconnects a read spans', async () => {
  const { client, reconnect } = host()
  let crossings = 2
  reads.answers = async () => {
    if (crossings > 0) {
      crossings -= 1
      reconnect()
    }
    return [
      {
        key: 'studio\nlocal',
        pairedHostId: 'studio',
        executionHost: 'local',
        answer: { kind: 'unreadable' }
      }
    ]
  }
  const result = await read(client)
  expect(result.epoch).toBe('3:3000')
})

it('leaves a computer’s rooms unknown when its own answer couldn’t be read', async () => {
  const { client } = host()
  reads.answers = async () => [
    {
      key: 'studio\nlocal',
      pairedHostId: 'studio',
      executionHost: 'local',
      answer: { kind: 'unreadable' }
    }
  ]
  expect((await read(client)).groups).toBeNull()
})
