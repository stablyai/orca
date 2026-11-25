import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { BotItemsOwnerList } from '../../../../src/shared/rpc-contract/bots-items-params'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { groupItemsFresh } from '../phone-group-items-freshness'
import {
  botItemAskCardKey,
  readBotItemAskCardDraft,
  saveBotItemAskCardDraft
} from './bot-item-ask-card-drafts'
import { usePhoneBotItems, type PhoneBotItems } from './use-phone-bot-items'

const planned = makeTestBotItem(1, { status: 'planned' })
const closed = (n: number) => makeTestBotItem(n, { status: 'done' })
const members = [{ id: 'bot-a' }]
const notices = (all: number) => ({ rooms: 0, all, bots: {}, asks: { all: 0, bots: {} } })
let renderer: ReactTestRenderer | undefined
let current: PhoneBotItems
let reads = 0
let client: RpcClient
function Harness() {
  current = usePhoneBotItems({
    client,
    hostKey: 'host',
    botId: 'bot-a',
    chatIds: null,
    showing: true,
    reads
  })
  return null
}
const fresh = () => groupItemsFresh(members, notices(reads), new Map([['bot-a', current]]))
const reply = (items: ReturnType<typeof makeTestBotItem>[], cursor?: string): RpcResponse => ({
  id: '1',
  ok: true,
  result: { items, counts: {}, seenEventId: 'e10', ...(cursor ? { nextClosedCursor: cursor } : {}) }
})
const makeClient = (sendRequest: RpcClient['sendRequest']): RpcClient => ({
  sendRequest,
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  getLastInboundAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
})
const tick = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  reads = 0
})

it('keeps old rows but withholds all-clear through a notice, failed refresh, and retry', async () => {
  let settle: ((response: RpcResponse) => void) | undefined
  const port = {
    sendRequest: () =>
      new Promise<RpcResponse>((resolve) => {
        settle = resolve
      })
  }
  client = makeClient(port.sendRequest)
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await act(async () => {
    settle!(reply([planned]))
  })
  expect(fresh()).toBe(true)
  reads = 1
  await act(async () => {
    renderer!.update(createElement(Harness))
  })
  expect(current.read?.items.map((item) => item.uid)).toEqual(['uid-1'])
  expect(fresh()).toBe(false)
  await act(async () => {
    settle!({ id: '1', ok: false, error: { code: 'unavailable', message: 'offline' } })
  })
  expect(current.error).not.toBeNull()
  expect(fresh()).toBe(false)
  await act(async () => {
    current.retry()
  })
  expect(fresh()).toBe(false)
  await act(async () => {
    settle!(reply([planned]))
  })
  expect(fresh()).toBe(true)
})

it.each([false, true])(
  'pages closed items across refresh with an older host: %s',
  async (oldHost) => {
    let openReads = 0
    const requests: { closedCursor?: string; closedOnly?: boolean }[] = []
    const port = {
      sendRequest: async (_method: string, raw: unknown) => {
        const params = BotItemsOwnerList.parse(raw)
        requests.push(params)
        if (!params.closedCursor || oldHost || !params.closedOnly) {
          openReads++
        }
        const open = !params.closedCursor || oldHost || !params.closedOnly ? [planned] : []
        if (params.closedCursor === 'c1') {
          return reply([...open, closed(2)], 'c2')
        }
        if (params.closedCursor === 'c2') {
          return reply([...open, closed(3)])
        }
        return reply([...open, closed(4)], 'c1')
      }
    }
    client = makeClient(port.sendRequest)
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await tick()
    await act(async () => {
      expect((await current.loadMoreClosed!()).items.map((item) => item.uid)).toEqual(['uid-2'])
    })
    await act(async () => {
      expect((await current.loadMoreClosed!()).items.map((item) => item.uid)).toEqual(['uid-3'])
    })
    expect(openReads).toBe(oldHost ? 3 : 1)
    reads = 1
    await act(async () => {
      renderer!.update(createElement(Harness))
    })
    await tick()
    await tick()
    expect(current.items.map((item) => item.uid)).toEqual(['uid-2', 'uid-3'])
    expect(openReads).toBe(oldHost ? 6 : 2)
    expect(
      requests.map((request) => [request.closedCursor ?? null, request.closedOnly ?? false])
    ).toEqual([
      [null, false],
      ['c1', true],
      ['c2', true],
      [null, false],
      ['c1', true],
      ['c2', true]
    ])
  }
)

it('drops a kept answer card when the list read shows its item closed, not one typed while it was read', async () => {
  const shut = botItemAskCardKey('host', 'bot-a', 'uid-7')
  const reopened = botItemAskCardKey('host', 'bot-a', 'uid-8')
  const words = { '0': { picks: [], other: 'unsent' } }
  saveBotItemAskCardDraft(shut, 'e1', words)
  let settle: ((response: RpcResponse) => void) | undefined
  client = makeClient(
    () =>
      new Promise<RpcResponse>((resolve) => {
        settle = resolve
      })
  )
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  // Typed while the read was out: the item may have reopened since the host answered.
  saveBotItemAskCardDraft(reopened, 'e1', words)
  await act(async () => {
    settle!(reply([planned, closed(7), closed(8)]))
  })

  expect(readBotItemAskCardDraft(shut, 'e1')).toBeUndefined()
  expect(readBotItemAskCardDraft(reopened, 'e1')).toEqual(words)
})

it('drops a kept answer card when a Closed page read past the first shows its item closed', async () => {
  const deeper = botItemAskCardKey('host', 'bot-a', 'uid-9')
  const words = { '0': { picks: [], other: 'unsent' } }
  saveBotItemAskCardDraft(deeper, 'e1', words)
  client = makeClient(async (_method, raw) =>
    BotItemsOwnerList.parse(raw).closedCursor === 'c1'
      ? reply([closed(9)])
      : reply([planned, closed(4)], 'c1')
  )
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await tick()
  expect(readBotItemAskCardDraft(deeper, 'e1')).toEqual(words)

  await act(async () => {
    await current.loadMoreClosed!()
  })
  expect(readBotItemAskCardDraft(deeper, 'e1')).toBeUndefined()
})
