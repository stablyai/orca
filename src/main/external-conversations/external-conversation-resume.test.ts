import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import SyncDatabase from '../sqlite/sync-database'
import { readJournalDomainQueueFailure } from '../native-chat/agent-session-journal/journal-domain-queue-failures'
import { readJournalDomainQueuePauseContext } from '../native-chat/agent-session-journal/journal-domain-queue-pauses'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import type { ConversationChatHost } from './external-conversation-chat'
import { resumeRefusal } from './external-conversation-resume'

// Resume from a thread continues a chat only while its newest turn is the failed one: a stale or
// repeated press, after the chat was resumed in Orca or ran again, must not send a second continue.
const OWNED = { probeOwner: async () => ({ outcome: 'pid-absent' as const }) }
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  await rig?.dispose()
  rig = null
})

// The chat host as the seam reads it; `installed: false` is one not yet installed since a restart.
const hostOf = (chat: QueuedMessageTestRig, installed = true): ConversationChatHost => ({
  current: () => (installed ? chat.host : null),
  ensure: async () => chat.host,
  onChanged: () => () => {}
})
const resume = (chat: QueuedMessageTestRig, installed = true) =>
  resumeRefusal({ resume: true }, hostOf(chat, installed), SESSION)
const NOT_FAILED = { outcome: 'refused', reason: 'not_failed' }

// TEMP CI debug: the journal rows the failure-holds read uses.
function journalRows(root: string): unknown {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (/\.(sqlite|db)$/.test(entry.name)) {
        files.push(path)
      }
    }
  }
  walk(root)
  return files.map((file) => {
    try {
      const db = new DatabaseSync(file, { readOnly: true })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (!tables.some((t) => t.name === 'journal_items')) {
        db.close()
        return { file: file.slice(root.length) }
      }
      const items = db
        .prepare(
          `SELECT epoch, item_id, sequence, sequence_index, turn_marker, hidden, queue_command_turn,
             queue_failed_outcome, queue_failed_at, queue_failure_witnessed_through,
             queue_failure_report_turn_item_id FROM journal_items ORDER BY sequence, sequence_index`
        )
        .all()
      const head = db.prepare('SELECT * FROM journal_chat_state').all()
      const version = db.prepare('SELECT sqlite_version() AS v').get()
      db.close()
      const sync = new SyncDatabase(file, { readonly: true })
      const target = { sessionId: SESSION, epoch: String(head[0]?.epoch) }
      const product = {
        failedAt: readJournalDomainQueueFailure(sync, target),
        pauses: readJournalDomainQueuePauseContext(sync, target, null, []).pauses
      }
      sync.close()
      return { file: file.slice(root.length), version, product, items, head }
    } catch (error) {
      return { file: file.slice(root.length), error: String(error) }
    }
  })
}

// What the chat holds, for a failure message.
async function seen(chat: QueuedMessageTestRig): Promise<string> {
  const holds = await (
    await chat.host.conversation(SESSION)
  ).journal.queuedMessages
    .failureHolds()
    .catch((error: unknown) => String(error))
  const work = await chat.host.currentWork(SESSION)
  const pauses = await (
    await chat.host.conversation(SESSION)
  ).journal.queuedMessages
    .pauses()
    .catch((error: unknown) => String(error))
  const page = await chat.host.history({ sessionId: SESSION, direction: 'tail' })
  return JSON.stringify({
    rows: process.env.CI ? journalRows(chat.root) : undefined,
    now: Date.now(),
    holds,
    pauses,
    working: work?.working(),
    prompt: work?.hasActionablePrompt(),
    items: page.ok ? page.page.items.map((item) => item.body) : page
  })
}

async function failedTurn(chat: QueuedMessageTestRig): Promise<void> {
  const id = await chat.workingSend()
  const turnId = `turn-${id}`
  await chat.settleAccepted(id, id)
  chat
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId, ordinal: 1 },
      { kind: 'turn', turnId, state: 'completed', outcome: 'failure', userItemId: `orca:${id}` },
      { turnScope: { kind: 'thread' } }
    )
  chat.providerEvents().publish()
  // The queue's failure read is the journal database's: let the turn's write land there first.
  await chat.providerEvents().written?.()
  await eventually(async () => expect(await resume(chat), await seen(chat)).toBeNull())
}

describe('resumeRefusal', () => {
  it('lets a failed chat resume once, then refuses after Orca resumed it', async () => {
    rig = await createQueuedMessageTestRig(OWNED)
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
    await failedTurn(rig)
    // A host not yet installed since a restart is installed, not taken as moved on.
    expect(await resume(rig, false)).toBeNull()
    expect(await rig.resume()).toMatchObject({ ok: true })
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
  })

  // A person's send (a thread's Resume is one) runs at once rather than waiting behind the pause.
  it('refuses once someone sends in the chat after the failure', async () => {
    rig = await createQueuedMessageTestRig(OWNED)
    await failedTurn(rig)
    await rig.send('try it this way').result
    expect(await resume(rig)).toMatchObject(NOT_FAILED)
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(await rig.drafts()).toEqual([])
  })
})
