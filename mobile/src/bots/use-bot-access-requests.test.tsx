import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), decide: vi.fn(), listed: new Array<unknown>() }))
vi.mock('./bot-access-request-operations', () => ({
  botAccessRequestsRead: { request: mocks.read, interpret: () => ({ accepted: false }) },
  decideBotAccessRequest: mocks.decide
}))
vi.mock('./bot-access-request-copy', () => ({ accessDecideFailureLine: () => '' }))
vi.mock('../host-screen/sidebar-feed/host-sidebar-feed-operations', () => ({
  readHostMethodReply: () => ({ kind: 'answered', value: { ok: true, value: mocks.listed } })
}))

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { makeAccessRequest } from '../../../src/shared/bots/bot-access-request.test-fixture'
import { useBotAccessRequests, type BotAccessRequests } from './use-bot-access-requests'
import type { RouteBot } from './use-route-bot'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked operations never touch the client.
const client = {} as RpcClient

function routeBot(reads: number): RouteBot {
  return {
    bot: {
      id: 'bot-1',
      name: 'Reviewer',
      folderWorkspaceId: 'fw-1',
      avatar: null,
      paused: false,
      agent: 'claude',
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      members: [],
      slack: null,
      linear: null,
      github: null,
      chatSessionId: null
    },
    avatar: { kind: 'mascot', id: 'A1' },
    activity: null,
    listStatus: null,
    needsYou: 0,
    applyBot: () => {},
    refresh: () => {},
    reads,
    itemReads: reads
  }
}

let latest: BotAccessRequests | null = null

function Probe({ reads, visible }: { reads: number; visible: boolean }) {
  latest = useBotAccessRequests({
    client,
    routeBot: routeBot(reads),
    visible,
    showToast: () => {}
  })
  return null
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  mocks.read.mockReset()
  mocks.decide.mockReset()
  mocks.listed = []
})

describe('the sheet’s access requests', () => {
  it('re-reads with each route read while the sheet is open, and not while it is closed', async () => {
    mocks.read.mockResolvedValue({ ok: true })
    await act(async () => {
      tree = create(createElement(Probe, { reads: 1, visible: true }))
    })
    await act(async () => tree?.update(createElement(Probe, { reads: 2, visible: true })))
    await act(async () => tree?.update(createElement(Probe, { reads: 3, visible: false })))

    expect(mocks.read).toHaveBeenCalledTimes(2)
  })
  it('keeps an answered request gone when a read that started before the host saved it lists it again', async () => {
    const asking = makeAccessRequest({ requestId: 'req-1', botId: 'bot-1' })
    mocks.listed = [asking]
    mocks.read.mockResolvedValue({ ok: true })
    mocks.decide.mockResolvedValue({ ok: true })
    await act(async () => {
      tree = create(createElement(Probe, { reads: 1, visible: true }))
    })
    expect(latest?.requests).toEqual([asking])

    await act(async () => latest?.decide(asking, 'declined'))
    await act(async () => tree?.update(createElement(Probe, { reads: 2, visible: true })))

    expect(latest?.requests).toEqual([])
  })
})
