import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

const world = vi.hoisted(() => {
  /** The chat each admission claimed its files for. */
  const admittedInto: ({ sessionId: string } | null)[] = []
  /** Each later claim: the chat, and the admitted text and images it claimed. */
  const claimedFor: { sessionId: string | null; text: string; images: string[] }[] = []
  return { taking: new Set<string>(), admittedInto, claimedFor }
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
  },
  claimBotItemCommentAttachments: async (
    deps: { chat: () => Promise<{ sessionId: string } | null> },
    text: string,
    images: { path: string }[]
  ) => {
    world.claimedFor.push({
      sessionId: (await deps.chat())?.sessionId ?? null,
      text,
      images: images.map(({ path }) => path)
    })
  }
}))
vi.mock(
  '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry',
  () => ({
    getAgentSessionAttachmentStore: () => ({}),
    getAgentSessionAttachmentClaimer: () => null
  })
)

const { claimItemMailFilesForHome, withItemMailFiles } = await import('./bot-item-mail-files')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only these.
const filesRuntime = {
  bots: { list: () => [{ id: 'bot-1', name: 'Nightly' }] },
  botItems: { store: () => ({}) },
  ensureStructuredAgentSessionHost: async () => {}
} as unknown as OrcaRuntimeService

describe('--item --file', () => {
  it("claims the admitted files for the Home Chat when the mail goes there after the item's chat closed", async () => {
    const sent = { to: 'bot:Nightly', params: { item: '11', files: ['/private-fixture/shot.png'] } }
    const admitted = {
      ...sent,
      params: { ...sent.params, body: 'see @/store/notes.txt' },
      images: ['/store/shot.png']
    }
    await claimItemMailFilesForHome(filesRuntime, sent, admitted)
    expect(world.claimedFor).toEqual([
      { sessionId: 'home-chat', text: 'see @/store/notes.txt', images: ['/store/shot.png'] }
    ])

    // Mail that brought no files claims nothing.
    world.claimedFor.length = 0
    const plain = { to: 'bot:Nightly', params: { item: '11', body: 'hi' } }
    await claimItemMailFilesForHome(filesRuntime, plain, plain)
    expect(world.claimedFor).toEqual([])
  })

  it("admits the files into the item's chat while it takes mail, and the Home Chat once it closed", async () => {
    const runtime = filesRuntime
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
