import { afterEach, describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationBotTarget
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  readAutomationRunMessage,
  type AutomationRunMessage
} from '../../shared/automations/automation-run-message'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { automationHomeOf, type BotHomeOf } from '../../shared/bots/bot-home-of'
import type { BotAccountShare } from '../../shared/bots/bot-team-shares'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { withCallerHome } from '../runtime/rpc/methods/automations/runs-in-caller-chat'
import type { BotRunFields } from '../bots/bot-chat-session'
import { readBotActingTurn } from '../bots/bot-request-asker'
import { firstMessageActsFor } from '../bots/first-message-acts-for'
import { deliverBotRunResult, type BotRunDeliveryDependencies } from '../bots/bot-run-results'
import { makeTestBot } from '../bots/bot.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { createBotAutomationDispatcher, type BotAutomationSessions } from './bot-automation-launch'

const ALICE_ID = 'acct-alice'
const alice: BotRequestAsker = {
  kind: 'person',
  source: 'orca',
  userId: ALICE_ID,
  name: 'Alice',
  workspaceId: null,
  role: 'member'
}
const OWNER: BotRequestAsker[] = [{ kind: 'owner' }]
const aliceShare: BotAccountShare = {
  kind: 'account',
  shareId: 'share-alice',
  accountId: ALICE_ID,
  name: 'Alice',
  email: 'alice@example.com',
  addedAt: 1,
  acceptedAt: 2
}
const bot = makeTestBot({ chatSessionId: 'owner-home', shares: [aliceShare] })
const personName = (accountId: string) => (accountId === ALICE_ID ? 'Alice' : null)

// Chats of the agent: whom each acts for, as Orca recorded it.
const ACTS_FOR: Record<string, BotRequestAsker[]> = {
  'alice-chat': [alice],
  'owner-chat': OWNER
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stamping reads only this record.
const db = {
  listBotConversationActsFor: (roots: readonly string[]) =>
    new Map(roots.flatMap((root) => (ACTS_FOR[root] ? [[root, { actsFor: ACTS_FOR[root] }]] : [])))
} as unknown as OrchestrationDb
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stamping reads the agent list and these records.
const runtime = {
  bots: { list: () => [bot] },
  getOrchestrationDb: () => db,
  listAutomationRuns: () => [],
  showAutomation: () => {
    throw new Error('gone')
  }
} as unknown as OrcaRuntimeService

function installBotChats(): void {
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  const records = ['alice-chat', 'owner-chat'].map((sessionId) => ({
    sessionId,
    location: { workspaceId: home }
  }))
  const host = {
    deps: {
      store: {
        getConversation: (id: string) => records.find((record) => record.sessionId === id),
        listConversations: () => records
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stamping reads only where a chat lives.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

const TARGET = (runsIn: AutomationBotTarget['runsIn']): AutomationBotTarget => ({
  botId: bot.id,
  runsIn,
  resultsTo: 'chat'
})

/** What the dispatcher sent where, for one automation's run. */
async function launch(target: AutomationBotTarget) {
  const sent: {
    actsFor?: BotRequestAsker[]
    home?: BotHomeOf
    run?: BotRunFields
    notStarted?: BotRequestAsker[]
  } = {}
  const send = { sessionId: 's-1', clientMessageId: 'm-1', fingerprint: 'f' }
  const sessions: BotAutomationSessions = {
    startConversation: async (_bot, input) => {
      sent.actsFor = [...input.actsFor.actsFor]
      sent.run = input.run
      return send
    },
    sendToBotChat: async () => send,
    sendToSession: async () => send,
    release: async () => {},
    sendToChat: async (_bot, home, _text, run) => {
      sent.home = home
      sent.run = run
      return send
    },
    homeOf: (_bot, saved) => (saved ? automationHomeOf(saved, () => 'owner') : 'owner')
  }
  const dispatch = createBotAutomationDispatcher(sessions, {
    watch: async () => ({ next: () => new Promise(() => {}), dispose: () => {} }),
    deliver: async () => ({ status: 'completed', outputSnapshot: null }),
    couldNotStart: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a manual run reads only these fields.
  const automation = {
    id: 'a-1',
    name: 'Morning check',
    prompt: 'Check the build.',
    enabled: true,
    bot: target
  } as Automation
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a manual run reads only these fields.
  const run = { id: 'r-1', trigger: 'manual', title: 'Morning check' } as AutomationRun
  await dispatch({
    automation,
    run,
    target: { ok: true, cwd: '/', bot, workspaceId: 'w1', runsIn: target.runsIn }
  })
  return sent
}

function runMessage(run: AutomationRunMessage, itemId = 'm1'): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Check the build.' }],
      memorySource: 'automation',
      origin: 'automation-run',
      automationRun: run
    }
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a run message's card reads only these.
const FACTS = { id: 'a-1', name: 'Morning check' } as AutomationRunMessage['automation']

const lookups = (conversationActsFor: readonly BotRequestAsker[]) => ({
  isBotRequest: () => false,
  botRequestActsFor: () => null,
  conversationActsFor,
  conversationWorkspaceId: null,
  personName
})

describe('a teammate’s automation acts for the teammate', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('is stamped with the teammate made in their chat, whatever it runs in; the owner’s is not', () => {
    installBotChats()
    for (const runsIn of ['new', 'chat'] as const) {
      expect(withCallerHome(runtime, 'alice-chat', TARGET(runsIn)).home).toBe(ALICE_ID)
      expect(withCallerHome(runtime, 'owner-chat', TARGET(runsIn))).toEqual(TARGET(runsIn))
    }
    expect(withCallerHome(runtime, undefined, TARGET('new'))).toEqual(TARGET('new'))
  })

  it('opens its new conversation for the teammate, and that turn acts for them alone', async () => {
    const sent = await launch({ ...TARGET('new'), home: ALICE_ID })
    expect(sent.actsFor).toEqual([alice])
    const message = sent.run!.automationRun!
    expect(message.home).toBe(ALICE_ID)
    expect(readBotActingTurn([runMessage(message)], lookups(sent.actsFor!)).askers).toEqual([alice])
  })

  it('an owner’s automation, and one saved before stamping, act for the owner', async () => {
    expect((await launch(TARGET('new'))).actsFor).toEqual(OWNER)
  })

  it('runs "in chat" in the teammate’s Home', async () => {
    expect((await launch({ ...TARGET('chat'), home: ALICE_ID })).home).toEqual({
      accountId: ALICE_ID
    })
    expect((await launch(TARGET('chat'))).home).toBe('owner')
  })

  it('keeps the teammate through a send-again, as the run message is read back', () => {
    const run: AutomationRunMessage = {
      runId: 'r-1',
      automation: FACTS,
      trigger: 'manual',
      instructionsLength: 5,
      home: ALICE_ID
    }
    const read = readAutomationRunMessage(JSON.parse(JSON.stringify(run)))
    expect(read?.home).toBe(ALICE_ID)
    expect(readBotActingTurn([runMessage(read!)], lookups(OWNER)).askers).toEqual([alice])
  })

  it('holds a turn two runs opened to both people, and reads a chat Alice’s run opened as hers', () => {
    const base = {
      runId: 'r-1',
      automation: FACTS,
      trigger: 'manual' as const,
      instructionsLength: 5
    }
    // One turn took both: the owner's run, and Alice's steered into it.
    const inTurn = (item: AgentJournalRenderItem): AgentJournalRenderItem => ({
      ...item,
      turnScope: { kind: 'turn', turnItemId: 't1' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: turn windows read only that it is a turn.
    const turn = {
      itemId: 't1',
      revision: 1,
      sequence: 3,
      observedAt: 1,
      body: { kind: 'turn', turnId: 't1', state: 'running' }
    } as AgentJournalRenderItem
    const both = readBotActingTurn(
      [
        inTurn(runMessage(base, 'm1')),
        inTurn(runMessage({ ...base, runId: 'r-2', home: ALICE_ID }, 'm2')),
        turn
      ],
      lookups(OWNER)
    )
    expect(both.askers).toEqual([{ kind: 'owner' }, alice])
    expect(
      firstMessageActsFor([runMessage({ ...base, home: ALICE_ID })], {
        botRequestAskers: () => null,
        conversationWorkspaceId: null,
        personName
      })
    ).toEqual([alice])
  })
})

describe('a teammate’s automation results land in their Home', () => {
  it.each([false, true])('with the agent reacting: %s', async (letBotReact) => {
    const homes: BotHomeOf[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a finished chat result reads only these.
    const deps = {
      homeOf: (_bot: unknown, target: AutomationBotTarget | undefined) =>
        target ? automationHomeOf(target, () => 'owner') : 'owner',
      noteToChat: async (_bot: unknown, home: BotHomeOf) => {
        homes.push(home)
      },
      sendToChat: async (_bot: unknown, home: BotHomeOf) => {
        homes.push(home)
      },
      notify: () => {}
    } as unknown as BotRunDeliveryDependencies
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a chat result reads only these.
    const completion = await deliverBotRunResult(deps, {
      automation: {
        id: 'a-1',
        name: 'Morning check',
        dtstart: 1,
        bot: { ...TARGET('new'), home: ALICE_ID }
      },
      run: { id: 'r-1', trigger: 'manual' },
      bot,
      target: { runsIn: 'new', resultsTo: 'chat', letBotReact },
      sessionId: 's-1',
      ended: { outcome: 'success', message: 'All green.' }
    } as Parameters<typeof deliverBotRunResult>[1])
    expect(completion.status).toBe('completed')
    expect(homes).toEqual([{ accountId: ALICE_ID }])
  })
})
