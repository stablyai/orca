import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { publishHostBots } from '../../../../bots/host-bot-store'
import { phoneBotSchema } from '../../../../bots/host-bots-operations'
import { createFakeRpcClient } from '../../../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { markRpcDeliveryUnknown } from '../../../../transport/rpc/rpc-delivery-ambiguity'
import {
  MobileBotCardHostContext,
  MobileBotCardSendContext,
  mobileBotOfferTell,
  type MobileBotCardHost
} from './mobile-bot-card-host'
import { useMobileBotOfferAnswer, type MobileBotOfferAnswer } from './use-mobile-bot-offer-answer'

vi.mock('../../../../worktree/execution-hosts/use-route-capability', () => ({
  useRouteCapability: () => true
}))

it('answers as a card answer on a host that takes one, and typed on an older host', async () => {
  const typed: string[] = []
  const answered: [string, string][] = []
  const card = { typed: async (text: string) => (typed.push(text), true), sessionId: 'chat-1' }
  const cardAnswer = async (text: string, sessionId: string) => (
    answered.push([text, sessionId]),
    true
  )

  await expect(mobileBotOfferTell(card, cardAnswer, 'Dismiss')).resolves.toBe(true)
  expect(answered).toEqual([['Dismiss', 'chat-1']])
  expect(typed).toEqual([])

  // An older host has no card answer: the phone types, as it always did.
  await expect(mobileBotOfferTell(card, null, 'Import all of it.')).resolves.toBe(true)
  expect(typed).toEqual(['Import all of it.'])
  expect(answered).toHaveLength(1)
})

it('retries a lost mobile reply while pending and publishes only the host-confirmed choice', async () => {
  const client = createFakeRpcClient()
  const host: MobileBotCardHost = {
    client,
    hostKey: 'offer-test-host',
    pairedHostId: 'desktop',
    hostLabel: 'Mac',
    openBotChat: () => {},
    openBotHome: () => {},
    editOffer: () => {}
  }
  publishHostBots(host.hostKey, {
    hideBotCreated: false,
    bots: [
      phoneBotSchema.parse({
        id: 'offer-test-bot',
        name: 'Import bot',
        folder: 'import',
        folderWorkspaceId: 'home',
        avatar: null,
        paused: false,
        agent: 'claude',
        notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
        members: [],
        slack: null,
        linear: null,
        github: null
      })
    ]
  })

  let view!: MobileBotOfferAnswer
  let renderer: ReactTestRenderer | undefined
  function Card() {
    view = useMobileBotOfferAnswer('offer-test-bot', 'plan')
    return null
  }

  try {
    await act(async () => {
      renderer = create(
        createElement(
          MobileBotCardHostContext.Provider,
          { value: host },
          createElement(
            MobileBotCardSendContext.Provider,
            { value: { sessionId: 'chat', typed: async () => false } },
            createElement(Card)
          )
        )
      )
    })
    await act(async () => view.send('Import 1', ['1']))
    expect(view).toMatchObject({ ready: false, sent: null, error: null })

    await act(async () => {
      client.requests[0]?.reject(markRpcDeliveryUnknown(new Error('The reply was lost.')))
    })
    expect(client.requests.map(({ method }) => method)).toEqual([
      'bots.offer.answer',
      'bots.offer.answer'
    ])
    expect(client.requests[1]?.args[1]).toEqual(client.requests[0]?.args[1])
    expect(view).toMatchObject({ ready: false, sent: null, error: null })

    await act(async () => {
      client.requests[1]?.resolve({
        ok: true,
        id: 'confirmed',
        result: { sent: true, answer: { cardId: 'plan', sent: { chosen: ['1', '2'] } } }
      })
    })
    expect(view).toMatchObject({ ready: true, sent: ['1', '2'], error: null })
  } finally {
    act(() => renderer?.unmount())
  }
})
