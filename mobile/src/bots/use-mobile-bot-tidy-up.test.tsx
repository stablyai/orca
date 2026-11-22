import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./bot-tidy-up-operations', () => ({
  tidyUpGet: { request: mocks.get, interpret: (reply: unknown) => reply },
  tidyUpNow: { request: vi.fn(), interpret: (reply: unknown) => reply },
  tidyUpUndo: { request: vi.fn(), interpret: (reply: unknown) => reply }
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

import type { BotTidyUpView } from '../../../src/shared/bots/bot-tidy-up'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useMobileBotTidyUp } from './use-mobile-bot-tidy-up'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked operations never touch the client.
const client = {} as RpcClient

const view = (running: boolean): BotTidyUpView => ({
  setting: { on: true, every: 'night' },
  last: null,
  running,
  turnedOff: null,
  error: null
})

let latest: BotTidyUpView | null = null

function Probe({ reads }: { reads: number }) {
  latest = useMobileBotTidyUp(client, 'bot-1', reads, () => {}).view
  return null
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  mocks.get.mockReset()
})

describe("the phone's Tidy-up", () => {
  it('shows a run ending once the route reads the bot again', async () => {
    mocks.get.mockResolvedValueOnce({ tidyUp: view(true) })
    await act(async () => {
      tree = create(createElement(Probe, { reads: 1 }))
    })
    expect(latest?.running).toBe(true)

    mocks.get.mockResolvedValueOnce({ tidyUp: view(false) })
    await act(async () => tree?.update(createElement(Probe, { reads: 2 })))
    expect(latest?.running).toBe(false)
  })
})
