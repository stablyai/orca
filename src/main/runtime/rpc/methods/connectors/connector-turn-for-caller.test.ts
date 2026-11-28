// Whom a bot's turn acts for, by who asks: a request Orca verified as the chat itself reads the turn;
// one it verified as another chat, or verified as none (a paired client, no evidence), says none; the
// host's own delivery of a run's result reads the turn.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_ACTS_FOR } from '../../../../../shared/bots/bot-acts-for'

const { reply } = vi.hoisted(() => ({ reply: vi.fn() }))
// The owner's own turn: only a caller Orca trusts may say so.
vi.mock('../orchestration/messaging/bot-recipient', () => ({
  readBotTurn: async () => ({ turn: { askers: [...OWNER_ACTS_FOR] }, conversation: null })
}))

import { botTurnFor } from '../../../../bots/bot-turn-for'
import { needsOrchestrationCallerResolution } from '../../orchestration/callers/orchestration-session-caller'
import { CONNECTOR_METHODS } from './connector'

const CHAT = '55555555-5555-4555-8555-555555555555'
const OTHER_CHAT = '66666666-6666-4666-8666-666666666666'

const runtime = {
  getOrchestrationDb: () => ({}),
  bots: { enabled: () => true, list: () => [] },
  getExternalConversationSeam: () => ({
    replyTarget: () => ({
      key: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
      turnId: 2,
      place: 'slack:T1:C1:1712.1'
    })
  }),
  getConnectorCloud: () => ({ cloudFeatures: () => new Set<string>(), reply })
}

function context(callerSessionId?: string): unknown {
  return {
    runtime,
    ...(callerSessionId
      ? {
          orchestrationCaller: {
            address: `orca_session_id:${callerSessionId}`,
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: callerSessionId,
            sessionId: callerSessionId,
            workspaceId: 'w'
          }
        }
      : {})
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.reply's handler, called with the params and context it reads.
const replyHandler = CONNECTOR_METHODS.find((method) => method.name === 'connector.reply')!
  .handler as (params: unknown, context: unknown) => Promise<unknown>

async function replySends(callerSessionId?: string): Promise<unknown> {
  reply.mockClear()
  await replyHandler({ sessionId: CHAT, replyId: 'r1', text: 'done' }, context(callerSessionId))
  return reply.mock.calls[0]?.[0]?.turnFor
}

describe('whom a bot turn acts for, by who asks', () => {
  beforeEach(() => {
    reply.mockReset()
    reply.mockResolvedValue({ ok: true, value: {} })
  })

  it('connector.reply reads the turn only for the chat Orca verified as the caller', async () => {
    expect(await replySends(CHAT)).toBe('owner')
    expect(await replySends(OTHER_CHAT)).toBe('none')
    // No verified session: a paired client, or a request with no evidence, is no trusted host.
    expect(await replySends()).toBe('none')
  })

  it('reads the turn for the host’s own delivery of a run’s result', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the turn reader is faked above.
    const host = runtime as unknown as Parameters<typeof botTurnFor>[0]
    expect(await botTurnFor(host, CHAT, 'host')).toBe('owner')
    expect(await botTurnFor(host, CHAT, { verifiedSessionId: undefined })).toBe('none')
  })

  it('verifies the chat a reaction names, as it does an action’s or a reply’s', () => {
    for (const method of ['connector.act', 'connector.reply', 'connector.react']) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only the method and its evidence.
      const request = {
        id: 'r1',
        method,
        params: { sessionId: CHAT },
        orchestrationCompatibilityEvidence: { agentSessionId: CHAT }
      } as unknown as Parameters<typeof needsOrchestrationCallerResolution>[0]
      expect(needsOrchestrationCallerResolution(request, undefined)).toBe(true)
    }
  })
})
