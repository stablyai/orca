import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../../shared/bot-types'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

const taking = vi.hoisted(() => ({
  chats: new Set<string>(),
  /** Runs while the item's files are read, as a close of its chat meanwhile would. */
  duringFiles: () => {}
}))
vi.mock('../../bots-chats', () => ({
  botChatTakingMail: async (_runtime: unknown, _bot: unknown, id: string) =>
    taking.chats.has(id) ? { title: null, sessionId: id } : null
}))
vi.mock('../../bots-items-write-support', () => ({
  resolveItem: async (_store: unknown, item: string) => ({
    number: Number(item),
    ownerBotId: 'bot-1',
    chatId: `chat-of-${item}`
  })
}))
vi.mock('./bot-request-send', () => ({ mayReachBot: () => false, sendToBot: async () => null }))
vi.mock('./bot-item-mail-files', () => ({
  withItemMailFiles: async <T>(_runtime: unknown, mail: T) => {
    taking.duringFiles()
    return mail
  },
  itemMailFilesBody: () => ''
}))
vi.mock('../../../../../bots/bot-session-tabs', () => ({ botOfSession: () => ({ id: 'bot-1' }) }))

const { routeBotMail } = await import('./bot-chat-address')

function route(chatId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: --item routing reads only its id and name.
  const bot = { id: 'bot-1', name: 'Nightly' } as Bot
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: --item routing reads only these.
  const runtime = {
    bots: { list: () => [bot] },
    botItems: { store: () => ({}), owningChat: () => ({ id: chatId }) },
    ensureStructuredAgentSessionHost: async () => {}
  } as unknown as OrcaRuntimeService
  return routeBotMail(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: nothing here reaches a bot, so only the runtime is read.
    { runtime } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: --item routing reads only the address and params.
    { to: 'bot:Nightly', params: { item: '11' } } as never
  )
}

describe('--item mail', () => {
  it("reaches the item's chat while it takes mail, and the Home Chat once it closed", async () => {
    const open = randomUUID()
    taking.chats.add(open)
    if (!isOrcaSessionId(open)) {
      throw new Error('a UUID is a session id')
    }
    await expect(route(open)).resolves.toEqual({ to: formatOrcaSessionAddress(open) })
    await expect(route(randomUUID())).resolves.toEqual({ to: 'bot:Nightly' })
  })

  it('goes to the Home Chat when the chat closes while the files are read', async () => {
    const closing = randomUUID()
    taking.chats.add(closing)
    taking.duringFiles = () => taking.chats.delete(closing)
    await expect(route(closing)).resolves.toEqual({ to: 'bot:Nightly' })
  })
})
