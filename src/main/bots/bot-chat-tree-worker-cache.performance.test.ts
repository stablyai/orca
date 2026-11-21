// A chats-tree refresh re-reads only running workers and Dispatches that changed, not every shown
// settled worker: a host with hundreds of chats spent 1-2 s per refresh in worker lookups.
import { afterEach, expect, it } from 'vitest'
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import { readBotChatTree } from './bot-chat-tree-host'
import { BotChatTreeWorkerCache } from './bot-chat-tree-worker-cache'
import { bot, closeOwnChatHost, homeRecord, ownChatHost } from './bot-own-chat-panes.test-fixture'

afterEach(() => closeOwnChatHost())

function worker(dispatchId: string, state: OrchestrationSessionWorker['state']) {
  return {
    dispatchId,
    taskId: `t-${dispatchId}`,
    runId: 'run-1',
    title: dispatchId,
    agent: 'claude',
    state,
    liveness: 'exited',
    host: 'local',
    worktreeId: null,
    paneKey: null,
    chatSessionId: null,
    startedAt: 1,
    settledAt: state === 'working' ? null : 2
  } satisfies OrchestrationSessionWorker
}

it('re-reads only the running and changed workers on a refresh, at N and 10N chats', async () => {
  for (const count of [20, 200]) {
    const host = ownChatHost(
      Array.from({ length: count }, (_, i) => homeRecord(`side-chat-${i}`, `Chat ${i}`))
    )
    const insert = host
      .db()
      .db.prepare(
        'INSERT INTO dispatch_contexts (id, task_id, status, creator_orca_session_id) VALUES (?, ?, ?, ?)'
      )
    for (let i = 0; i < count; i++) {
      insert.run(`ctx-${i}-a`, `t-${i}-a`, 'completed', `side-chat-${i}`)
      insert.run(`ctx-${i}-b`, `t-${i}-b`, 'failed', `side-chat-${i}`)
    }
    insert.run('ctx-running', 't-running', 'dispatched', 'side-chat-0')
    const requested: string[][] = []
    const cache = new BotChatTreeWorkerCache()
    // As the runtime binds it: the database's own row-change notice drops a kept read.
    host.db().workerStatusListener = (id, change) => cache.rowChanged(id, change)
    const tree = {
      ...host,
      workerCache: cache,
      dispatchWorkers: async (ids: readonly string[]) => {
        requested.push([...ids])
        return ids.map((id) =>
          worker(id, id === 'ctx-running' ? 'working' : id.endsWith('-a') ? 'completed' : 'failed')
        )
      }
    }

    await readBotChatTree(tree, { botId: bot.id })
    expect(requested[0]).toHaveLength(count * 2 + 1)

    await readBotChatTree(tree, { botId: bot.id })
    expect(requested[1]).toEqual(['ctx-running'])

    host
      .db()
      .db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'ctx-7-a'")
      .run()
    await readBotChatTree(tree, { botId: bot.id })
    expect(requested[2]?.sort()).toEqual(['ctx-7-a', 'ctx-running'])
    closeOwnChatHost()
  }
})
