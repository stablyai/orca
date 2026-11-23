import { afterEach, describe, expect, it } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  setAgentSessionRecordUserName,
  type AgentSessionUserNameWrite
} from '../runtime/agent-session/records/agent-session-record-conversation-name'
import { botChatRecordRow } from '../runtime/rpc/methods/bots-chats'
import SyncDatabase from '../sqlite/sync-database'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'
import { nameBotGroupMemberChats } from './bot-group-member-chat-names'

const ROOM = 'bot-group-member-room'
const THREAD = 'bot-group-member-thread'
const PROMPT = 'You are responding in the shared group "Release"…'

/** Chat records as the host keeps them, named by the host's own write rule. */
function chats(names: Record<string, Partial<AgentSessionRecord>>) {
  const records = new Map(
    Object.entries(names).map(([sessionId, fields]) => [
      sessionId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads and writes only these fields.
      { sessionId, updatedAt: 0, ...fields } as AgentSessionRecord
    ])
  )
  const host = {
    deps: { store: { readOnly: false, getConversation: (id: string) => records.get(id) } },
    setUserConversationName: async (id: string, name: string, write: AgentSessionUserNameWrite) => {
      const record = records.get(id)
      if (record) {
        records.set(id, setAgentSessionRecordUserName(record, name, write, 1).record)
      }
      return null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming uses only the store read and the name write.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  /** The title `orca bot chats`, the row line and an item's Chat field show: the record's name. */
  const title = (id: string) =>
    botChatRecordRow(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a row reads the record's name and turn.
      records.get(id) as never,
      (sessionId) => sessionId,
      null
    )?.title
  return { title }
}

function rooms(threadTitle?: string) {
  const store = new BotGroupStore(new SyncDatabase(':memory:'))
  const group: BotGroup = {
    id: 'room-1',
    name: 'Release',
    hostId: 'local',
    revision: 1,
    folder: '/work/release',
    folderWorkspaceId: 'folder:release',
    createdAt: 0,
    members: [{ botId: 'bot-0', sessionId: ROOM }],
    threads: [
      {
        id: 'thread-1',
        createdAt: 0,
        members: [{ botId: 'bot-0', sessionId: THREAD }],
        ...(threadTitle ? { title: threadTitle } : {})
      }
    ],
    replyMode: { kind: 'all' }
  }
  store.put(group)
  const runtime = { ensureStructuredAgentSessionHost: async () => undefined }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads the room store and the installed host.
  return { store, group, groups: { store, runtime } as unknown as BotGroupRuntime }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe("a member chat's name", () => {
  it("is its room's name, a thread's title once it has one, not the room prompt", async () => {
    const { title } = chats({ [ROOM]: {}, [THREAD]: { conversationName: PROMPT } })
    const { groups, group } = rooms()
    await nameBotGroupMemberChats(groups, [group])
    expect([title(ROOM), title(THREAD)]).toEqual(['Release', 'Release'])
    const titled = { ...group, threads: group.threads!.map((t) => ({ ...t, title: 'Notes' })) }
    await nameBotGroupMemberChats(groups, [{ ...titled, name: 'Ship' }])
    expect([title(ROOM), title(THREAD)]).toEqual(['Ship', 'Notes'])
  })

  it('opens no chat host when there are no rooms to name', async () => {
    const store = new BotGroupStore(new SyncDatabase(':memory:'))
    const runtime = {
      ensureStructuredAgentSessionHost: async () => {
        throw new Error('opened the chat host')
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads the room store and the host.
    const groups = { store, runtime } as unknown as BotGroupRuntime
    await expect(nameBotGroupMemberChats(groups)).resolves.toBeUndefined()
  })

  it('names chats made before this on load, leaving one someone renamed', async () => {
    const { title } = chats({
      [ROOM]: { conversationName: PROMPT },
      [THREAD]: { conversationName: 'Mine', conversationNameSource: 'user' }
    })
    const { groups } = rooms('Notes')
    await nameBotGroupMemberChats(groups, undefined, { kept: true })
    expect([title(ROOM), title(THREAD)]).toEqual(['Release', 'Mine'])
  })
})
