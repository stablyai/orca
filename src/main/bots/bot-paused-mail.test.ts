import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { Bot } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'

const hostRef: { current: unknown } = { current: null }
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { pausedBotChatHoldsMail, releaseHeldBotMail } = await import('./bot-paused-mail')
const { OrchestrationDb } = await import('../runtime/orchestration/db/orchestration-db')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} =
  await import('../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity')

const HOME_CHAT = testOrcaSessionId('1b2c3d4e-0001-4a5b-8c6d-7e8f9a0b1c2d')
const SIDE_CHAT = testOrcaSessionId('1b2c3d4e-0002-4a5b-8c6d-7e8f9a0b1c2d')
const WORKER = testOrcaSessionId('1b2c3d4e-0005-4a5b-8c6d-7e8f9a0b1c2d')

let db: InstanceType<typeof OrchestrationDb>
let bot: Bot
const wakeQueuedMessages = vi.fn()

function runtime() {
  return {
    bots: { list: () => [bot] },
    getOrchestrationDb: () => db,
    redriveStructuredSessionMail: vi.fn()
  }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  bot = makeTestBot({ id: 'ranger', chatSessionId: HOME_CHAT, paused: true })
  const records = new Map<string, AgentSessionRecord>(
    [HOME_CHAT, SIDE_CHAT, WORKER].map((sessionId) => {
      const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      return [sessionId, { ...record, location: { ...record.location, workspaceId: 'folder:w1' } }]
    })
  )
  hostRef.current = {
    wakeQueuedMessages,
    deps: {
      store: {
        getConversation: (id: string) => {
          const record = records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => [...records.values()].map(agentSessionConversationView),
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...records.keys()] })
      }
    }
  }
  structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: WORKER,
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey(WORKER),
    processIncarnation: structuredWorkerProcessIncarnation(WORKER),
    worktreeId: 'folder:w1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
})

afterEach(() => {
  structuredWorkerIdentities.clear()
  db.close()
  hostRef.current = null
  wakeQueuedMessages.mockReset()
})

describe('a paused bot holds its chats’ mail', () => {
  it("holds the paused bot's own chats only, never a worker running in its home", () => {
    expect(pausedBotChatHoldsMail(runtime(), HOME_CHAT)).toBe(true)
    expect(pausedBotChatHoldsMail(runtime(), SIDE_CHAT)).toBe(true)
    expect(pausedBotChatHoldsMail(runtime(), WORKER)).toBe(false)
  })

  it('holds nothing for a bot that is not paused', () => {
    bot = { ...bot, paused: false }
    expect(pausedBotChatHoldsMail(runtime(), HOME_CHAT)).toBe(false)
  })

  it("on resume redrives each of the bot's own chats, not its workers", () => {
    const resumed = runtime()
    releaseHeldBotMail(resumed, bot)
    expect(resumed.redriveStructuredSessionMail.mock.calls.map(([id]) => id).toSorted()).toEqual(
      [HOME_CHAT, SIDE_CHAT].toSorted()
    )
    expect(wakeQueuedMessages).toHaveBeenCalledTimes(2)
  })
})
