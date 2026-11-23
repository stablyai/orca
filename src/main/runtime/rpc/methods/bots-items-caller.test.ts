import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

const hostRef: { current: unknown } = { current: null }
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { itemsWriter } = await import('./bots-items-caller')
const { OrchestrationDb } = await import('../../orchestration/db/orchestration-db')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} =
  await import('../../orchestration/terminal-authority/structured-sessions/structured-worker-identity')

const HOME_CHAT = testOrcaSessionId('1b2c3d4e-0001-4a5b-8c6d-7e8f9a0b1c2d')
const SIDE_CHAT = testOrcaSessionId('1b2c3d4e-0002-4a5b-8c6d-7e8f9a0b1c2d')
const THREAD_CHAT = testOrcaSessionId('1b2c3d4e-0003-4a5b-8c6d-7e8f9a0b1c2d')
const AUTOMATION_RUN = testOrcaSessionId('1b2c3d4e-0004-4a5b-8c6d-7e8f9a0b1c2d')
const WORKER = testOrcaSessionId('1b2c3d4e-0005-4a5b-8c6d-7e8f9a0b1c2d')
const LOST_WORKER = testOrcaSessionId('1b2c3d4e-0006-4a5b-8c6d-7e8f9a0b1c2d')

const bot = makeTestBot({ id: 'ranger', name: 'Ranger', chatSessionId: HOME_CHAT })

function homeRecord(sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return { ...record, location: { ...record.location, workspaceId: 'folder:w1' } }
}

let db: InstanceType<typeof OrchestrationDb>

function context(): Pick<RpcContext, 'runtime' | 'pairedDeviceId'> {
  const runtime = {
    bots: { enabled: () => true, list: () => [bot] },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null },
    botItems: { chatSource: () => ({ kind: 'side', title: 'Chat' }) },
    getOrchestrationDb: () => db
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: itemsWriter reads only bots, lookAround, botItems.chatSource and the orchestration database.
  return { runtime: runtime as unknown as OrcaRuntimeService, pairedDeviceId: undefined }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  const records = new Map<string, AgentSessionRecord>(
    [HOME_CHAT, SIDE_CHAT, THREAD_CHAT, AUTOMATION_RUN, WORKER, LOST_WORKER].map((id) => [
      id,
      homeRecord(id)
    ])
  )
  hostRef.current = {
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
})

describe('who writes bot items', () => {
  it.each([
    ['home chat', HOME_CHAT],
    ['side chat', SIDE_CHAT],
    ['thread chat', THREAD_CHAT],
    ['automation run chat', AUTOMATION_RUN]
  ])("lets the bot's %s write as the bot", (_kind, sessionId) => {
    expect(itemsWriter(sessionId, context()).actor).toEqual({
      kind: 'bot',
      botId: 'ranger',
      chatId: sessionId
    })
  })

  it('refuses a worker a Dispatch started in the bot home', () => {
    expect(() => itemsWriter(WORKER, context())).toThrow(/Only a bot writes items/)
  })

  it('refuses a worker its Dispatch recorded after this host lost its identity', () => {
    const runId = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: HOME_CHAT
    }).id
    db.createDispatchContext({
      taskId: db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: 'term_lost',
      processIncarnation: structuredWorkerProcessIncarnation(LOST_WORKER),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    expect(() => itemsWriter(LOST_WORKER, context())).toThrow(/Only a bot writes items/)
  })
})
