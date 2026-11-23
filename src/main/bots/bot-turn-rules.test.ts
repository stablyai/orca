import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { createBotTurnContext } from './bot-turn-context'
import { botSessionInstructions } from './bot-session-instructions'
import { botRulesBlock } from './bot-preamble'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRewindRecord } from '../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { AgentSessionStoreState } from '../runtime/agent-session/records/agent-session-store-state'
import { commitAgentSessionRewindCompletion } from '../runtime/agent-session/records/agent-session-rewind-completion'

const FOLDER = '/home/me/.orca/bots/scout'
const BLOCK = '## Tools\n\n- new tool\n\n## Rules\n\n- new rule'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const keyOf = (text: string): string => sha256(`v2\n${text}`)
const say: AgentJournalMessageItem = { kind: 'message', role: 'user', blocks: [] }

function chat(launch: { delivered: boolean; recorded: string | null }) {
  const files = new Map([
    [join(FOLDER, 'SOUL.md'), 'Be brief.'],
    [join(FOLDER, 'MEMORY.md'), '- a fact']
  ])
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    replaceText: async () => false,
    writeText: async () => false
  }
  const context = createBotTurnContext(fs)
  context.launched('s1', 'bot-1', FOLDER, { soul: 'Be brief.', memory: '- a fact' }, true, {
    block: BLOCK,
    rebuilt: false,
    ...launch
  })
  return context
}

describe("Orca's Tools and Rules in a running bot chat", () => {
  it('a fresh start says nothing and only vouches for what it gave', async () => {
    const context = chat({ delivered: true, recorded: null })
    const plan = await context.plan('s1', say)
    expect(plan?.text).toBe('')
    expect(plan?.instructionsKey).toBe(keyOf(BLOCK))
    plan?.given({ instructionsRecorded: true })
    expect(await context.plan('s1', say)).toBeNull()
  })

  it('a running chat holding older rules is sent the new ones once', async () => {
    const context = chat({ delivered: false, recorded: keyOf('## Tools\n\n- old') })
    const plan = await context.plan('s1', say)
    expect(plan?.text.startsWith('[Orca rules update:')).toBe(true)
    expect(plan?.text).toContain('- new rule')
    expect(plan?.instructionsKey).toBe(keyOf(BLOCK))
    plan?.given({ instructionsRecorded: true })
    expect(await context.plan('s1', say)).toBeNull()
  })

  it('a resumed chat with no receipt (started before receipts) is sent them', async () => {
    const context = chat({ delivered: false, recorded: null })
    expect((await context.plan('s1', say))?.text).toContain('- new rule')
  })

  it('an unwritten receipt (a crash, a takeover) sends them again', async () => {
    const context = chat({ delivered: false, recorded: keyOf('## Tools\n\n- old') })
    ;(await context.plan('s1', say))?.given({ instructionsRecorded: false })
    expect((await context.plan('s1', say))?.text).toContain('- new rule')
  })

  it('a rewind of a running chat drops its receipt, so its next turn is sent them again', async () => {
    const context = chat({ delivered: false, recorded: keyOf('## Tools\n\n- old') })
    ;(await context.plan('s1', say))?.given({ instructionsRecorded: true })
    const rewind: AgentSessionRewindRecord = {
      operationId: 'rewind-1',
      callerKey: 'c',
      itemId: 'item-3',
      expectedEpoch: 'epoch-1',
      phase: 'provider-succeeded'
    }
    const live = agentSessionRecordFixture()
    const state: AgentSessionStoreState = {
      records: new Map([[live.sessionId, { ...live, rewind, instructionsKey: keyOf(BLOCK) }]]),
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    }
    expect(await context.plan('s1', say, keyOf(BLOCK))).toBeNull()
    // The child lives on through the rewind: no relaunch tells the turn context.
    commitAgentSessionRewindCompletion(state, live.sessionId, 7, rewind, {
      epoch: 'e2',
      sequence: 3
    })
    const held = state.records.get(live.sessionId)?.instructionsKey ?? null
    expect((await context.plan('s1', say, held))?.text).toContain('- new rule')
  })

  it('rides a turn a worker report starts', async () => {
    const context = chat({ delivered: false, recorded: null })
    const update = await context.launchUpdate?.('s1')
    expect(update?.text).toContain('- new rule')
    expect(update?.instructionsKey).toBe(keyOf(BLOCK))
  })
})

describe('what a bot launch says its context holds', () => {
  const bot = { id: 'bot-1', name: 'Scout', agent: 'claude' as const, folderWorkspaceId: 'ws' }
  const fs = { readText: async () => null }
  const turnOf = async (record: Parameters<typeof botSessionInstructions>[2]) => {
    const context = createBotTurnContext({
      ...fs,
      replaceText: async () => false,
      writeText: async () => false
    })
    await botSessionInstructions(context, [bot], record, FOLDER, null, fs)
    return context.plan('s1', say)
  }
  const codexChat = {
    sessionId: 's1',
    provider: 'codex',
    location: { workspaceId: 'folder:ws' },
    providerHandleChain: [{}]
  }

  const claudeChat = { ...codexChat, provider: 'claude' }

  it('a resumed Claude chat keeps its recorded prompt, so it is sent them once', async () => {
    const context = createBotTurnContext({
      ...fs,
      replaceText: async () => false,
      writeText: async () => false
    })
    await botSessionInstructions(context, [bot], claudeChat, FOLDER, null, fs)
    const plan = await context.plan('s1', say)
    expect(plan?.text.startsWith('[Orca rules update:')).toBe(true)
    plan?.given({ instructionsRecorded: true })
    expect((await context.plan('s1', say))?.text ?? '').not.toContain('[Orca rules update:')
  })

  it('a resumed Cursor chat is given the rewritten rule, so it says nothing', async () => {
    const plan = await turnOf({ ...claudeChat, provider: 'cursor' })
    expect(plan?.text).toBe('')
  })

  it('a new Claude conversation is given them at start and says nothing', async () => {
    const plan = await turnOf({ ...claudeChat, providerHandleChain: [] })
    expect(plan?.text).toBe('')
    expect(plan?.instructionsKey).toBe(keyOf(botRulesBlock('claude')))
  })

  it('a key stored before the version bump no longer counts as held', async () => {
    const plan = await turnOf({ ...codexChat, instructionsKey: sha256(botRulesBlock('codex')) })
    expect(plan?.text.startsWith('[Orca rules update:')).toBe(true)
  })

  it("a chat keeps its own agent's rules when the bot's agent changes", async () => {
    const plan = await turnOf({ ...codexChat, instructionsKey: keyOf(botRulesBlock('codex')) })
    expect(plan?.text ?? '').not.toContain('[Orca rules update:')
  })

  it("a fork may carry its source's thread, so it is sent them", async () => {
    const plan = await turnOf({
      ...codexChat,
      providerHandleChain: [],
      forkedFrom: { sessionId: 's0', itemId: 'i1', childBoundary: { kind: 'start' } }
    })
    expect(plan?.text.startsWith('[Orca rules update:')).toBe(true)
  })
})
