import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

const world = vi.hoisted(() => {
  /** The chat each admission claimed its files for. */
  const admittedInto: ({ sessionId: string } | null)[] = []
  return { taking: new Set<string>(), admittedInto }
})
vi.mock('../../bots-chats', () => ({
  botChatTakingMail: async (_runtime: unknown, _bot: unknown, id: string) =>
    world.taking.has(id) ? { title: null, sessionId: id } : null,
  botHomeChatTakingMail: async () => ({
    title: 'Home',
    sessionId: 'home-chat'
  })
}))
vi.mock('../../bots-items-write-support', () => ({
  resolveItem: async (_store: unknown, item: string) => ({
    number: Number(item),
    ownerBotId: 'bot-1',
    chatId: `chat-of-${item}`
  })
}))
vi.mock('../../../../../bots/bot-item-comment-attachments', () => ({
  admitBotItemCommentAttachments: async (
    deps: { chat: () => Promise<{ sessionId: string } | null> },
    text: string
  ) => {
    world.admittedInto.push(await deps.chat())
    return { text, images: [] }
  }
}))
vi.mock(
  '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry',
  () => ({
    getAgentSessionAttachmentStore: () => ({}),
    getAgentSessionAttachmentClaimer: () => null
  })
)

const { withItemMailFiles } = await import('./bot-item-mail-files')

describe('--item --file', () => {
  it("admits the files into the item's chat while it takes mail, and the Home Chat once it closed", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only these.
    const runtime = {
      bots: { list: () => [{ id: 'bot-1', name: 'Nightly' }] },
      botItems: { store: () => ({}) },
      ensureStructuredAgentSessionHost: async () => {}
    } as unknown as OrcaRuntimeService
    const mail = {
      to: 'bot:Nightly',
      params: { item: '11', files: ['/private-fixture/notes.txt'] }
    }
    world.taking.add('chat-of-11')
    await withItemMailFiles(runtime, mail)
    world.taking.clear()
    await withItemMailFiles(runtime, mail)
    expect(world.admittedInto.map((chat) => chat?.sessionId ?? null)).toEqual([
      'chat-of-11',
      'home-chat'
    ])
  })
})
