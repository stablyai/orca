import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import '../runtime/orchestration/db/contract-constants'
import '../runtime/orchestration/db/messages/mailbox-routing-page'
import '../runtime/orchestration/db/dispatch-row-writer'
import '../runtime/orchestration/db/attempt-outcome-projection'
import { botDispatches } from './bot-chat-dispatches'
import { openRemoteRunLink } from '../runtime/orchestration/db/remote-owned/remote-run-links'
import {
  recordRemoteStart,
  reserveRemotePlacement
} from '../runtime/orchestration/db/remote-owned/remote-placements'
import {
  botChatTreeDispatchIds,
  placeBotChatDispatches
} from '../../shared/bots/bot-chat-tree-model'
import { botWorkspaceChats } from '../../shared/bots/bot-workspace-chats'

const CHAT_SESSION = testOrcaSessionId('chat-session')

const opened: { db: OrchestrationDb; dir: string }[] = []

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function openDb(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bot-chat-dispatches-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  opened.push({ db, dir })
  return db
}

/** A Dispatch the bot's chat started, failed as the current writers fail one. */
function failedDispatch(db: OrchestrationDb, spec: string): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: `term_${spec}`,
    creator: { kind: 'session', orcaSessionId: CHAT_SESSION },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  db.failDispatch(dispatch.id, 'boom')
  return dispatch.id
}

function placed(db: OrchestrationDb) {
  return botDispatches(
    db,
    (sessionId) => (sessionId === CHAT_SESSION ? 'chat' : null),
    () => null,
    { orcaSessionIds: [CHAT_SESSION], paneKeys: [] }
  )
}

describe('botDispatches: settle times', () => {
  it('marks a settled Dispatch with no completion time as undated, still ordered by creation', () => {
    const db = openDb()
    const dated = failedDispatch(db, 'dated')
    const legacy = failedDispatch(db, 'legacy')
    // As the first failure writer left a row: failed, with no completion time.
    db.db.prepare('UPDATE dispatch_contexts SET completed_at = NULL WHERE id = ?').run(legacy)
    const row: unknown = db.db
      .prepare("SELECT strftime('%s', created_at) * 1000 AS ms FROM dispatch_contexts WHERE id = ?")
      .get(legacy)
    const createdMs = typeof row === 'object' && row !== null && 'ms' in row ? row.ms : null
    expect(typeof createdMs).toBe('number')

    const byId = new Map(placed(db).map((dispatch) => [dispatch.id, dispatch]))
    // Still a failure: only its time is uncertain.
    expect(byId.get(legacy)).toMatchObject({
      settled: true,
      failed: true,
      undated: true,
      at: createdMs
    })
    expect(byId.get(dated)?.settled).toBe(true)
    expect(byId.get(dated)?.undated).toBeUndefined()
  })
})

describe('botDispatches: a worker started on a paired server', () => {
  it('places it under the chat that started it, as a local one is', () => {
    const db = openDb()
    const runId = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    const link = openRemoteRunLink(db, runId, {
      environmentId: 'env_server',
      name: 'Server',
      peerFingerprint: 'fp_server',
      homePeerFingerprint: 'fp_home',
      pairingRevision: 1
    })
    reserveRemotePlacement(db, {
      link,
      taskId: 'task_0123456789ab',
      requestKey: 'key',
      create: { spec: 'remote work' },
      creator: { kind: 'session', orcaSessionId: CHAT_SESSION }
    })
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId: 'task_0123456789ab',
      dispatchId: 'ctx_remote000001',
      requestKey: 'key',
      agent: 'claude',
      worktreeId: 'repo::/server/child'
    })

    const remote = placed(db).find((dispatch) => dispatch.id === 'ctx_remote000001')
    expect(remote).toMatchObject({
      chatId: 'chat',
      settled: false,
      worktreeId: 'repo::/server/child',
      serverEnvironmentId: 'env_server',
      agent: 'claude'
    })
    const chats = [
      {
        chatId: 'home',
        title: 'Home',
        origin: 'home' as const,
        live: 'idle' as const,
        lastActiveAt: 0,
        unread: false,
        closed: false
      },
      {
        chatId: 'chat',
        title: 'Chat',
        origin: 'side' as const,
        live: 'idle' as const,
        lastActiveAt: 0,
        unread: false,
        closed: false
      }
    ]
    // Its row is its Dispatch's: no worker record here is read for it, so settled reads stay cached.
    expect(botChatTreeDispatchIds(chats, placeBotChatDispatches(chats, [remote!]), [])).toEqual([])
    // The sidebar lists the server's workspace under its chat, not Home.
    expect(botWorkspaceChats(placeBotChatDispatches(chats, [remote!]), [], 'home')).toEqual({
      'repo::/server/child': 'chat'
    })
  })
})
