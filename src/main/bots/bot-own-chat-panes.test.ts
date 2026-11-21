import { afterEach, describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import {
  bot,
  closeOwnChatHost,
  homeRecord,
  ownChatHost as host
} from './bot-own-chat-panes.test-fixture'
import { makeTestBot } from './bot.test-fixture'

afterEach(closeOwnChatHost)

describe('readBotOwnChatPanes', () => {
  it('lists the bot’s side chats and leaves out a Dispatch worker running in its home', async () => {
    const side = homeRecord('chat-side', 'Plan the launch')
    const worker = homeRecord('chat-worker', 'Fix the build')
    structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: worker.sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(worker.sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(worker.sessionId),
      worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const chats = await readBotOwnChatPanes(host([side, worker]))
    expect(chats[bot.id]?.map((chat) => chat.title)).toEqual(['Plan the launch'])
  })

  it('reads only the bots named', async () => {
    const botCount = 10
    const bots = Array.from({ length: botCount }, (_, i) =>
      makeTestBot({
        id: `bot-${i}`,
        folderWorkspaceId: `home-${i}`,
        chatSessionId: `home-chat-${i}`
      })
    )
    const records = bots.map((each, i) =>
      homeRecord(`chat-side-${i}`, `Side ${i}`, each.folderWorkspaceId)
    )
    const tabReads: string[] = []
    const read = host(records, bots, tabReads)
    const named = await readBotOwnChatPanes(read, ['bot-3'])
    expect(Object.keys(named)).toEqual(['bot-3'])
    expect(named['bot-3']?.map((chat) => chat.title)).toEqual(['Side 3'])
    expect(tabReads).toHaveLength(1)
    // Without names, every bot is answered, as before.
    tabReads.splice(0)
    const all = await readBotOwnChatPanes(read)
    expect(Object.keys(all)).toHaveLength(botCount)
    expect(tabReads).toHaveLength(botCount)
  })

  it('leaves out a worker that lost its identity (listed as ended), and one held only by its durable terminal row', async () => {
    const sides = Array.from({ length: 3 }, (_, i) => homeRecord(`chat-side-${i}`, `Side ${i}`))
    const lost = homeRecord('chat-lost-worker', 'Lost worker')
    const restarted = homeRecord('chat-restarted-worker', 'Restarted worker')
    const read = host([...sides, lost, restarted])
    const database = read.db()
    for (const record of [lost, restarted]) {
      const processIncarnation = structuredWorkerProcessIncarnation(record.sessionId)
      const handle = mintStructuredWorkerHandle()
      const dispatch = database.createDispatchContext({
        taskId: database.createTask({ runId: 'run_legacy_local', spec: 'work' }).id,
        assigneeHandle: handle,
        processIncarnation,
        creator: { kind: 'system' },
        maxDepth: 10
      })
      if (record === restarted) {
        database.createWorkerTerminalResourceStatement({
          dispatchId: dispatch.id,
          terminalHandle: handle,
          paneKey: mintStructuredWorkerPaneKey(record.sessionId),
          processIncarnation,
          worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
          ownership: 'owned',
          hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
        })
      }
    }
    const chats = await readBotOwnChatPanes(read)
    expect(chats[bot.id]?.map((chat) => chat.title).toSorted()).toEqual([
      'Side 0',
      'Side 1',
      'Side 2'
    ])
  })
})
