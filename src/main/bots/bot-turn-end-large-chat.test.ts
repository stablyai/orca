import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { parseBotMemoryFacts } from '../../shared/bot-memory-lines'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from '../native-chat/agent-session-journal/journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from '../native-chat/agent-session-journal/journal-sql-point-read'
import { journalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { readTurnEndedItems } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botChatJournal } from './bot-chat-reads'
import { createBotTurnContext } from './bot-turn-context'
import { HELD_BOT_RULES, TAKEN } from './bot-turn-rules.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

const FOLDER = '/home/me/.orca/bots/reviewer'
const MEMORY = join(FOLDER, 'MEMORY.md')
const OUTPUT_BYTES = 100_000
const OLD_TURNS = 120
const DANA = 'Slack, Dana <https://app.slack.com/client/T1/C1>'

const owner = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const dana: AgentJournalMessageItem = {
  ...owner('remember how we deploy'),
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U-Dana',
    name: 'Dana',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' },
    url: 'https://app.slack.com/client/T1/C1'
  }
}
const bigToolCall: AgentJournalItemBody = {
  kind: 'tool-call',
  name: 'Bash',
  input: { command: 'cat build.log' },
  output: {
    head: 'x'.repeat(OUTPUT_BYTES),
    byteLength: OUTPUT_BYTES,
    digest: '',
    truncated: false
  },
  state: 'completed'
}
const editsMemory: AgentJournalItemBody = {
  kind: 'tool-call',
  name: 'Edit',
  input: { file_path: MEMORY, new_string: '- deploys at noon' },
  state: 'completed'
}

/** A bot Home whose journal holds over 12 MB of tool output after an unanswered send and one early
 *  Slack-asked turn, as Orca relaunched finds it, read through the reader worker's real point reads. */
async function largeBotHome() {
  const f = domainLifecycleFixture(cleanup)
  const turn = async (
    id: string,
    opener: AgentJournalMessageItem,
    ...work: AgentJournalItemBody[]
  ) => {
    await f.run({ kind: 'item', identity: identity(`${id}-ask`), options, body: opener })
    await f.run({
      kind: 'item',
      identity: identity(`${id}-turn`),
      options,
      body: {
        kind: 'turn',
        turnId: `${id}-turn`,
        state: 'completed',
        outcome: 'success',
        completedAt: 1_000,
        userItemId: `orca:${id}-ask`
      }
    })
    for (const [index, body] of work.entries()) {
      await f.run({
        kind: 'item',
        identity: identity(`${id}-work-${index}`),
        options: { ...options, turnScope: { kind: 'turn', turnItemId: `orca:${id}-turn` } },
        body
      })
    }
  }
  // A send never answered (Orca died while handing it over) sits ahead of all the history.
  await f.run({
    kind: 'submission',
    input: { clientMessageId: 'stuck', fence: 1, body: owner('stuck'), payloadFingerprint: 'stuck' }
  })
  await turn('slack', dana, bigToolCall)
  for (let index = 0; index < OLD_TURNS; index += 1) {
    await turn(`old-${index}`, owner(`check build ${index}`), bigToolCall)
  }
  const replies = { bytes: 0 }
  const reads = journalSqlReads(
    {
      point: async (request) => {
        const reply = readJournalSqlPoint(f.db, request)
        replies.bytes += JSON.stringify(reply).length
        return reply
      }
    },
    'chat'
  )
  const files = new Map([[MEMORY, '']])
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    replaceText: async (path: string, expected: string, text: string) =>
      files.get(path) === expected && Boolean(files.set(path, text)),
    writeText: async (path: string, text: string) => Boolean(files.set(path, text))
  }
  const context = createBotTurnContext(
    fs,
    undefined,
    botChatJournal(async () => reads)
  )
  context.launched('chat', 'bot-1', FOLDER, { soul: null, memory: '' }, true, HELD_BOT_RULES)
  return {
    turn,
    replies,
    memory: () => files.get(MEMORY) ?? '',
    /** The owner asks; the bot writes `fact` to MEMORY.md; turn `turnId`'s end runs. */
    /** The end has run when `fact` carries `source`, or, for a fact the owner gave, when the end's
     *  "Memory updated" note is written. */
    ended: async (turnId: string, fact: string, source: string | null = DANA) => {
      ;(await context.plan('chat', owner(`remember: ${fact}`)))?.given(TAKEN)
      files.set(MEMORY, `${files.get(MEMORY) ?? ''}- ${fact}\n`)
      const noted: string[] = []
      context.turnEnded?.(
        'chat',
        turnId,
        (since) => readTurnEndedItems(reads, turnId, since),
        async (id) => void noted.push(id)
      )
      await vi.waitFor(() =>
        source === null
          ? expect(noted).toHaveLength(1)
          : expect(
              parseBotMemoryFacts(files.get(MEMORY) ?? '').find(({ text }) => text === fact)?.source
            ).toBe(source)
      )
    }
  }
}

const facts = (text: string) =>
  parseBotMemoryFacts(text).map(({ text: fact, source }) => [fact, source])

it("a bot's first turn end after launch reads its ended turn, not a huge chat, and still credits an early Slack ask", async () => {
  const home = await largeBotHome()
  await home.turn('last', owner('remember: deploys at noon'), bigToolCall, editsMemory)
  await home.ended('last-turn', 'deploys at noon')

  expect(facts(home.memory())).toEqual([['deploys at noon', DANA]])
  // The chat holds over 12 MB of tool output, 100 KB in the turn before and 100 KB in this one: the
  // end reads none of it.
  expect(home.replies.bytes).toBeLessThan(50_000)
})

it('a first end that names no turn row, such as a refused send, leaves the next end bounded', async () => {
  const home = await largeBotHome()
  await home.ended('refused-send-item', 'deploys at noon')
  await home.turn('next', owner('remember: ship on fridays'), editsMemory)
  home.replies.bytes = 0
  await home.ended('next-turn', 'ship on fridays', null)

  expect(facts(home.memory())).toEqual([
    ['deploys at noon', DANA],
    ['ship on fridays', null]
  ])
  expect(home.replies.bytes).toBeLessThan(50_000)
})
