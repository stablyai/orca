import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotActingTurn } from '../../../bots/bot-request-asker'
import { CONNECTOR_ACT_METHOD } from './connector-act'
import { CONNECTOR_REACT_METHOD } from './connector-react'
import { readBotTurn } from './orchestration/messaging/bot-recipient'

vi.mock('./orchestration/messaging/bot-recipient', () => ({ readBotTurn: vi.fn() }))

const turn = (wokenAt: BotActingTurn['wokenAt']): BotActingTurn => ({
  rootItemId: 'm1',
  askers: [{ kind: 'owner' }],
  askedBy: [{ kind: 'owner' }],
  request: null,
  actingOnRequestId: null,
  requestIds: [],
  wokenAt
})

const context = {
  runtime: { bots: { enabled: () => true }, getOrchestrationDb: () => ({}) }
}
const conversation = { source: 'slack' as const, externalId: 'T1:C1:1.2:U1' }
const react = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only bots.enabled and the db, both supplied.
  CONNECTOR_REACT_METHOD.handler({ sessionId: 's1', emoji: ':eyes:' }, context as never)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('orca bot reply --react', () => {
  it.each([
    [
      'any source, on the exact message the cloud named',
      {
        source: 'linear' as const,
        placeId: 'ENG-1',
        messageRef: 'linear:o1:i1:s1:c9'
      },
      { source: 'linear' as const, externalId: 'o1:s1' },
      'linear:o1:i1:s1:c9'
    ],
    [
      'Slack from an older cloud, on the message that started the thread',
      {
        source: 'slack' as const,
        placeId: 'C1',
        url: 'https://app.slack.com/client/T1/C1/thread/C1-1.2'
      },
      conversation,
      'slack:T1:C1:1.2:1.2'
    ],
    [
      'GitHub, on the comment by its link',
      {
        source: 'github' as const,
        placeId: 'acme/api#7',
        url: 'https://github.com/acme/api/issues/7#issuecomment-9'
      },
      { source: 'github' as const, externalId: 'i1:acme/api:7:bot' },
      'https://github.com/acme/api/issues/7#issuecomment-9'
    ]
  ])('reacts as the bot in %s', async (_, wokenAt, answered, ref) => {
    vi.mocked(readBotTurn).mockResolvedValue({
      turn: turn(wokenAt),
      conversation: answered,
      actsFor: [{ kind: 'owner' }],
      triggeredBy: null
    })
    const act = vi
      .spyOn(CONNECTOR_ACT_METHOD, 'handler')
      .mockResolvedValue({ ok: true, result: { target: { ref: 'slack:T1:C1', label: 'x' } } })
    await expect(react()).resolves.toEqual({ ok: true })
    expect(act).toHaveBeenCalledWith(
      { sessionId: 's1', verb: 'react', ref, args: { emoji: ':eyes:' } },
      context
    )
  })

  it.each([
    ['no message woke it', turn(null), conversation],
    [
      'a Linear wake',
      turn({ source: 'linear', placeId: 'ENG-1', url: 'https://linear.app/x' }),
      conversation
    ],
    [
      'a chat answering no conversation',
      turn({ source: 'slack', placeId: 'C1', url: 'https://x' }),
      null
    ]
  ])('says there is nothing to react to for %s', async (_, read, answered) => {
    vi.mocked(readBotTurn).mockResolvedValue({
      turn: read,
      conversation: answered,
      actsFor: [{ kind: 'owner' }],
      triggeredBy: null
    })
    const act = vi.spyOn(CONNECTOR_ACT_METHOD, 'handler')
    await expect(react()).rejects.toMatchObject({ code: 'no_waking_message' })
    expect(act).not.toHaveBeenCalled()
  })
})
