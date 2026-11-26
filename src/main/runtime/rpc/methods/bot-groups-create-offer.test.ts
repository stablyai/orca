import { expect, it } from 'vitest'
import type { AgentJournalPlainStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { botGroupOfferOf } from '../../../../shared/bots/bot-group-offer'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import SyncDatabase from '../../../sqlite/sync-database'
import { InvalidArgumentError, type RpcContext } from '../core'
import { BOT_GROUP_CREATE_OFFER_METHOD } from './bot-groups-create-offer'

it('never writes an offer its reader drops when the caller takes membership past the limit', async () => {
  const db = new SyncDatabase(':memory:')
  const written: AgentJournalPlainStatusItem[] = []
  const bots = Array.from({ length: 33 }, (_, i) => ({
    id: `bot-${i}`,
    name: `Bot ${i}`,
    hostId: 'local',
    folderWorkspaceId: `home-${i}`
  }))
  const host = {
    deps: {
      store: { getConversation: () => ({ location: { workspaceId: 'folder:home-0' } }) }
    },
    captureAgentStartDestination: async () => ({
      sessionId: 'chat-0',
      epoch: '1',
      contextId: null
    }),
    appendAgentStart: async (
      _destination: unknown,
      { body }: { body: AgentJournalPlainStatusItem }
    ) => {
      written.push(body)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offer only reads these runtime services.
  const runtime = {
    bots: { assertEnabled: () => {}, list: () => bots },
    lookAround: { botOfLook: () => null },
    getOrchestrationDb: () => ({ db })
  } as unknown as RpcContext['runtime']
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offer only looks up its home and writes a status item.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  const call = (botIds: string[], withoutCaller?: true) =>
    BOT_GROUP_CREATE_OFFER_METHOD.handler(
      BOT_GROUP_CREATE_OFFER_METHOD.params.parse({
        callerSessionId: 'chat-0',
        name: 'Team',
        botIds,
        withoutCaller
      }),
      { runtime }
    )
  const others = bots.slice(1).map((bot) => bot.id)
  try {
    await expect(call(others)).rejects.toBeInstanceOf(InvalidArgumentError)
    expect(written).toEqual([])

    await call(others.slice(0, 31))
    const withCaller = botGroupOfferOf(written[0])
    expect(withCaller?.members).toHaveLength(32)
    expect(withCaller?.members[0]).toEqual({ botId: 'bot-0', name: 'Bot 0' })
    expect(withCaller?.members[31]).toEqual({ botId: 'bot-31', name: 'Bot 31' })

    await call(others, true)
    const withoutCaller = botGroupOfferOf(written[1])
    expect(withoutCaller?.members).toHaveLength(32)
    expect(withoutCaller?.members[0]).toEqual({ botId: 'bot-1', name: 'Bot 1' })
    expect(withoutCaller?.members[31]).toEqual({ botId: 'bot-32', name: 'Bot 32' })
  } finally {
    setStructuredAgentSessionHost(null)
    db.close()
  }
})
