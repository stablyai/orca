import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { StructuredAgentSessionCloseWork } from '../native-chat/agent-session-wire/termination/structured-agent-session-close-work'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { unfinishedRunChatCloses } from '../runtime/orchestration/db/bot-requests/bot-run-chat-unfinished-closes-store'

const lane = vi.hoisted(() => {
  const now: {
    tabs: Set<string>
    behind: Set<string>
    state: StructuredAgentSessionCloseWork['state']
    startEnds: Promise<boolean> | null
  } = {
    /** Chats a tab shows by the time the close reaches its last word. */
    tabs: new Set<string>(),
    /** Of those, the ones whose tab sits behind another in its workspace. */
    behind: new Set<string>(),
    state: 'idle',
    /** An agent still starting: the stop waits for that start to end. */
    startEnds: null
  }
  return now
})
// The close's last word in the session lane, as the host gives it: Stop only when it admits.
vi.mock('../runtime/agent-session/lifecycle/structured-agent-session-close', () => ({
  closeStructuredAgentSessionChild: async (
    sessionId: string,
    options: { admitClose: (work: StructuredAgentSessionCloseWork) => boolean }
  ) => {
    const stopped = options.admitClose({ sessionId, state: lane.state })
    return stopped && lane.startEnds
      ? { stopped: false, closeAttempted: true, whenStartEnds: lane.startEnds }
      : { stopped, closeAttempted: true }
  }
}))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    getSessionTabId: (id: string) => (lane.tabs.has(id) ? 'tab' : null)
  })
}))
vi.mock('./bot-chat-session', () => ({
  runtimeBotChats: () => ({
    underChatLock: async (
      _botId: string,
      work: (host: unknown, bot: Bot, chat: () => Promise<string>) => Promise<unknown>
    ) =>
      work(
        {},
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only these fields of the bot.
        { id: 'bot-1', chatSessionId: 'home-chat', closeEndedRuns: true } as Bot,
        async () => 'home-chat'
      )
  })
}))
vi.mock('./bot-chat-queued-carry', () => ({ carryQueuedMessages: async () => true }))
vi.mock('./bot-chat-replacement', () => ({ dropReplacedChatMail: async () => {} }))

const { runtimeRunChatClose } = await import('./bot-run-chat-close-step')

let db: OrchestrationDb
afterEach(() => {
  db.close()
  lane.tabs.clear()
  lane.behind.clear()
  lane.state = 'idle'
  lane.startEnds = null
})

function closer() {
  db = new OrchestrationDb(':memory:')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close step reads only the database.
  const runtime = {
    getOrchestrationDb: () => db,
    structuredSessionTabInFront: (id: string) => !lane.behind.has(id)
  } as unknown as OrcaRuntimeService
  return runtimeRunChatClose(runtime)
}

describe("a run chat close's last word", () => {
  it("refuses the close when the chat's tab came to the front since the recheck, and keeps no record", async () => {
    const { close } = closer()
    lane.tabs.add('run-chat')
    await expect(close('bot-1', 'run-chat', async () => true)).resolves.toBe('tab-in-front')
    expect(unfinishedRunChatCloses(db, 'bot-1')).toEqual([])
  })

  it('closes a chat whose tab sits behind another, tab and all', async () => {
    const { close } = closer()
    lane.tabs.add('run-chat')
    lane.behind.add('run-chat')
    await expect(close('bot-1', 'run-chat', async () => true)).resolves.toBe('closed')
    expect(unfinishedRunChatCloses(db, 'bot-1')).toEqual([])
  })

  it('refuses it while a turn runs, and closes it idle with no tab', async () => {
    const { close } = closer()
    lane.state = 'busy'
    await expect(close('bot-1', 'run-chat', async () => true)).resolves.toBe('failed')
    lane.state = 'idle'
    await expect(close('bot-1', 'run-chat', async () => true)).resolves.toBe('closed')
    expect(unfinishedRunChatCloses(db, 'bot-1')).toEqual([])
  })

  it('keeps the record while the stop waits for its agent to start, and finishes once it stopped', async () => {
    const { close } = closer()
    let startEnds: (stopped: boolean) => void = () => {}
    lane.startEnds = new Promise((resolve) => (startEnds = resolve))
    await expect(close('bot-1', 'run-chat', async () => true)).resolves.toBe('stopping')
    expect(unfinishedRunChatCloses(db, 'bot-1')).toEqual(['run-chat'])
    startEnds(true)
    await vi.waitFor(() => expect(unfinishedRunChatCloses(db, 'bot-1')).toEqual([]))
  })
})
