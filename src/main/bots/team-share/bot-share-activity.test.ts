import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { Automation } from '../../../shared/automations/automation-definition'
import { structuredAgentSessionStatusPaneKey } from '../../../shared/agent-session/view/structured-agent-session-tab'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from '../bot.test-fixture'
import { readBotActivity, type BotActivityHost } from '../bot-activity-host'
import { botShareActivityHost } from './bot-share-activity'

const bot = makeTestBot({
  id: 'bot-shared',
  folderWorkspaceId: 'home',
  chatSessionId: 'owners-home'
})
const chats = { alice: 'alices-chat', bob: 'bobs-chat', owner: 'owners-chat' }

/** A worker each chat started, as the host's status rows carry them. */
function workerRow(chat: string): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Activity reads only these fields of a row.
  return {
    paneKey: `pane-${chat}`,
    receivedAt: 1,
    state: 'working',
    stateStartedAt: 1,
    prompt: '',
    connectionId: null,
    orchestration: {
      taskId: `task-${chat}`,
      dispatchId: `dispatch-${chat}`,
      dispatchStatus: 'dispatched',
      taskTitle: `${chat} task`,
      parentPaneKey: structuredAgentSessionStatusPaneKey(chat)
    }
  } as unknown as AgentStatusIpcPayload
}

// The owner's host: every chat open as a tab, a thread, an automation and its Up next.
const ownersHost: BotActivityHost = {
  bots: () => [bot],
  externalConversations: () => [],
  chatTabs: async () => Object.values(chats).map((sessionId) => ({ sessionId, title: sessionId })),
  statusRows: () => Object.values(chats).map(workerRow),
  automations: () => [
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Activity lists an automation by these fields.
    {
      id: 'auto-1',
      name: 'Nightly',
      enabled: true,
      workspaceId: folderWorkspaceKey('home')
    } as unknown as Automation
  ],
  automationRuns: () => new Map(),
  recordedWorkers: async () => [],
  upNext: () => ({ state: { running: false, seenAt: 0 }, items: [] })
}

describe('a teammate’s Activity on the shared bot', () => {
  it('shows only the work their own chats started, none of the owner’s or another teammate’s', async () => {
    const owners = await readBotActivity(ownersHost, bot.id)
    expect(owners.workers.map((row) => row.title).sort()).toEqual([
      'alices-chat task',
      'bobs-chat task',
      'owners-chat task'
    ])
    expect(owners.automations).toHaveLength(1)
    expect(owners.upNext).toBeDefined()

    const alices = await readBotActivity(
      botShareActivityHost(ownersHost, bot, [{ sessionId: chats.alice, title: 'Mine' }]),
      bot.id
    )
    expect(alices.workers.map((row) => row.title)).toEqual(['alices-chat task'])
    expect(alices.completed).toEqual([])
    expect(alices.automations).toEqual([])
    expect(alices.waits).toEqual([])
    expect(alices.upNext).toBeUndefined()
  })
})
