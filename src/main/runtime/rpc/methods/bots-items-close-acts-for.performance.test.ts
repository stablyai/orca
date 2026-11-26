// Perf contract: whom a close acted for is read without walking the chats' conversation links, so
// its cost doesn't grow with how many conversations are linked, and its chat's first message, a
// whole prompt's payload, is read at most once a close.
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { closingTurnActsFor } from './bots-items-close-acts-for'

const CHAT = '11111111-1111-4111-8111-111111111111'
const typed: AgentJournalRenderItem = {
  itemId: 'typed',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'typed' }] }
}
const host = {
  deps: {},
  promptReads: 0,
  windowRefused: false,
  hasSession: (id: string) => id === CHAT,
  journalReads: async () => ({
    operationWindow: async () => {
      if (host.windowRefused) {
        throw Object.assign(new Error('crowded'), { name: 'JournalWindowNotIndexed' })
      }
      return { complete: true, snapshot: { items: [typed], submissions: [] } }
    },
    promptItem: async () => {
      host.promptReads += 1
      return typed
    }
  })
}
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

function runtimeWith(seam: unknown, record?: BotRequestAsker[]): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the DB's methods.
  const db = {
    getBotConversationActsFor: () => (record ? { actsFor: record } : undefined),
    getBotRequest: () => undefined
  } as unknown as OrchestrationDb
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the runtime's methods.
  return {
    ensureStructuredAgentSessionHost: async () => undefined,
    getExternalConversationSeam: () => seam,
    getOrchestrationDb: () => db
  } as unknown as OrcaRuntimeService
}

const close = (runtime: OrcaRuntimeService) =>
  closingTurnActsFor(runtime, { sessionId: CHAT, actor: { chatId: CHAT } })

async function linkVisits(links: number): Promise<number> {
  let visits = 0
  const paneKeys = Array.from({ length: links }, (_, index) => `pane-${index}`)
  // A reply target found by walking every linked conversation, as an unindexed lookup does.
  const seam = {
    replyTarget: (paneKey: string) => {
      for (const key of paneKeys) {
        visits += 1
        if (key === paneKey) {
          return null
        }
      }
      return null
    }
  }
  expect(await close(runtimeWith(seam, [...OWNER_ACTS_FOR]))).toEqual(OWNER_ACTS_FOR)
  return visits
}

async function promptReads(closes: number): Promise<number> {
  host.windowRefused = true
  host.promptReads = 0
  const runtime = runtimeWith(null)
  for (let index = 0; index < closes; index += 1) {
    await close(runtime)
  }
  host.windowRefused = false
  return host.promptReads
}

describe('a close reads whom it acted for', () => {
  it('visits no conversation link, at 750 links or 7,500', async () => {
    expect([await linkVisits(750), await linkVisits(7500)]).toEqual([0, 0])
  })

  it("reads the chat's first message once a close when its turn can't be read, at 10 closes or 100", async () => {
    expect([await promptReads(10), await promptReads(100)]).toEqual([10, 100])
  })
})
