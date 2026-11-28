import { afterEach, describe, expect, it } from 'vitest'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { botHome, withoutBotHome } from '../../shared/bots/bot-home-of'
import type { BotAccountShare } from '../../shared/bots/bot-team-shares'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { botHomeOfChat } from './bot-conversation-acts-for'
import { makeTestBot } from './bot.test-fixture'
import { botShareListedBots } from './team-share/bot-share-access'

// Orca session ids, so a /clear chain resolves to its root.
const ALICE_SIDE = '00000000-0000-4000-8000-0000000000a1'
const ALICE_SIDE_CLEARED = '00000000-0000-4000-8000-0000000000a2'
const ALICE_HOME = '00000000-0000-4000-8000-0000000000b1'
const ALICE_HOME_CLEARED = '00000000-0000-4000-8000-0000000000b2'
const OWNER_SIDE = '00000000-0000-4000-8000-0000000000c1'
const UNRECORDED = '00000000-0000-4000-8000-0000000000d1'

const alice: BotRequestAsker = {
  kind: 'person',
  source: 'orca',
  userId: 'acct-alice',
  name: 'Alice',
  workspaceId: null,
  role: 'member'
}
const ACTS_FOR: Record<string, BotRequestAsker[]> = {
  [ALICE_SIDE]: [alice],
  [ALICE_HOME]: [alice],
  [OWNER_SIDE]: [{ kind: 'owner' }]
}
const sources = {
  getOrchestrationDb: () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fallback reads only this record.
    ({
      listBotConversationActsFor: (roots: readonly string[]) =>
        new Map(
          roots.flatMap((root) => (ACTS_FOR[root] ? [[root, { actsFor: ACTS_FOR[root] }]] : []))
        )
    }) as unknown as OrchestrationDb,
  listAutomationRuns: () => [],
  showAutomation: () => {
    throw new Error('gone')
  }
}

function aliceShare(homeSessionId?: string): BotAccountShare {
  return {
    kind: 'account',
    shareId: 'share-alice',
    accountId: 'acct-alice',
    name: 'Alice',
    email: 'alice@example.com',
    addedAt: 1,
    acceptedAt: 2,
    ...(homeSessionId ? { homeSessionId } : {})
  }
}

/** The host's records: each chat /cleared once into its continuation. */
function installRecords(): void {
  const cleared = (sessionId: string, into: string) => ({
    sessionId,
    conversationCommand: { command: 'clear', phase: 'committed', replacementSessionId: into }
  })
  const records = [
    cleared(ALICE_SIDE, ALICE_SIDE_CLEARED),
    { sessionId: ALICE_SIDE_CLEARED },
    cleared(ALICE_HOME, ALICE_HOME_CLEARED),
    { sessionId: ALICE_HOME_CLEARED },
    { sessionId: OWNER_SIDE }
  ]
  const host = {
    deps: {
      store: {
        listConversations: () => records,
        getConversation: (id: string) => records.find((record) => record.sessionId === id),
        getVisibleSessionTabIndex: () => new Map()
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lineage reads only the record list.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

describe('mail for a closed or deleted chat falls back to its person’s Home', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('a teammate’s chat goes to their Home, even after a /clear moved it on; others to the owner’s', () => {
    installRecords()
    const bot = makeTestBot({ chatSessionId: 'owner-home', shares: [aliceShare()] })
    expect(botHomeOfChat(sources, bot, ALICE_SIDE)).toEqual({ accountId: 'acct-alice' })
    expect(botHomeOfChat(sources, bot, ALICE_SIDE_CLEARED)).toEqual({ accountId: 'acct-alice' })
    expect(botHomeOfChat(sources, bot, OWNER_SIDE)).toBe('owner')
    expect(botHomeOfChat(sources, bot, UNRECORDED)).toBe('owner')
  })

  it('a removed teammate’s chat goes to the owner’s Home', () => {
    installRecords()
    const bot = makeTestBot({ chatSessionId: 'owner-home', shares: [] })
    expect(botHomeOfChat(sources, bot, ALICE_SIDE)).toBe('owner')
  })
})

describe('deleting a teammate’s Home takes its pointer with it', () => {
  it.each([
    ['its first session', ALICE_HOME],
    ['a /clear continuation', ALICE_HOME_CLEARED]
  ])('when the pointer names %s', (_label, pointer) => {
    const bot = makeTestBot({ chatSessionId: 'owner-home', shares: [aliceShare(pointer)] })
    // The delete holds the chat's whole /clear chain before anything is removed.
    const deleted = new Set([ALICE_HOME, ALICE_HOME_CLEARED])
    const after = { ...bot, ...withoutBotHome(bot, deleted) }
    expect(botHome(after, { accountId: 'acct-alice' })).toBeNull()
    expect(after.chatSessionId).toBe('owner-home')
    const [projected] = botShareListedBots([after], { botId: bot.id, accountId: 'acct-alice' })
    expect(projected.chatSessionId).toBeNull()
  })

  it('leaves the shares as they were when the deleted chat was no Home', () => {
    const bot = makeTestBot({ chatSessionId: 'owner-home', shares: [aliceShare(ALICE_HOME)] })
    expect(withoutBotHome(bot, new Set([OWNER_SIDE, 'owner-home'])).shares).toBe(bot.shares)
  })
})
