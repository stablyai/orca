import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { latestStructuredAgentSessionUserItem } from '../../../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { readBotTurn } from './bot-recipient'

// Each chat's journal; a chat named in `unreadable` fails to open, as a lost root journal would,
// and one in `unreadableOnce` fails the next open only.
const journals: Record<string, AgentJournalRenderItem[]> = {}
const unreadable = new Set<string>()
const unreadableOnce = new Set<string>()
const opened: string[] = []

vi.mock('../../../../../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async (sessionId: string) => {
      opened.push(sessionId)
      if (unreadable.has(sessionId) || unreadableOnce.delete(sessionId)) {
        throw new Error('journal gone')
      }
      const items = journals[sessionId] ?? []
      return {
        operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } }),
        promptItem: async (end: 'first' | 'last') =>
          latestStructuredAgentSessionUserItem(end === 'first' ? items.toReversed() : items)
      }
    }
  })
}))

const PULLED_ROOT = '55555555-5555-4555-8555-555555555555'
const OWNER_ROOT = '66666666-6666-4666-8666-666666666666'
const OWNER = [{ kind: 'owner' as const }]

let sequence = 0
function firstMail(messageId: string): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `item_${sequence}`,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'mail' }],
      from: { orchestration: { message: 'mail-notice', messages: [{ messageId }] } }
    }
  } as unknown as AgentJournalRenderItem
}

describe("a chat's acts-for when an earlier version recorded it as the owner's", () => {
  let dir: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-pulled-root-'))
    db = new OrchestrationDb(join(dir, 'computer.db'))
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getExternalConversationSeam').mockReturnValue(null)
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
    opened.length = 0
    unreadable.clear()
    unreadableOnce.clear()
    for (const key of Object.keys(journals)) {
      delete journals[key]
    }
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A request this computer pulled from a paired server, addressed to `root`'s chat. */
  function pulledRequestTo(root: string): string {
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES ('peerconv_00000000aa01', 'peer', 'fingerprint_a', 'env_s')`
      )
      .run()
    const request = db.insertMessage({
      from: 'Ranger',
      to: `orca_session_id:${root}`,
      subject: 'Where is the guide?'
    })
    db.linkPeerMailMessage({
      conversationId: 'peerconv_00000000aa01',
      peerFingerprint: 'fingerprint_a',
      messageId: request.id,
      senderLabel: 'Ranger',
      environmentId: 'env_s'
    })
    db.db
      .prepare(
        `INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
         VALUES (?, 'root', 'docs', 'question', 0, ?)`
      )
      .run(request.id, JSON.stringify({ purpose: 'question', toBotName: 'Docs', askers: OWNER }))
    return request.id
  }

  it('acts for no one in a chat started for a pulled request, reading its journal once', async () => {
    db.recordBotConversationActsFor(PULLED_ROOT, { actsFor: OWNER })
    journals[PULLED_ROOT] = [firstMail(pulledRequestTo(PULLED_ROOT))]

    expect((await readBotTurn(runtime, db, PULLED_ROOT)).actsFor).toEqual([{ kind: 'unknown' }])
    // Its first message for provenance, then its turn.
    expect(opened).toHaveLength(2)
    expect((await readBotTurn(runtime, db, PULLED_ROOT)).actsFor).toEqual([{ kind: 'unknown' }])
    // The next action reads only its turn.
    expect(opened).toHaveLength(3)
  })

  it("keeps the owner's chat as it was, never opening its journal for provenance", async () => {
    db.recordBotConversationActsFor(OWNER_ROOT, { actsFor: OWNER })
    unreadable.add(OWNER_ROOT)

    // Its own turn read fails as before; provenance asked nothing of it first.
    await expect(readBotTurn(runtime, db, OWNER_ROOT)).rejects.toThrow('journal gone')
    expect(opened).toEqual([OWNER_ROOT])
  })

  it("never leaves the owner's authority to a chat a pulled request reached when its journal can't be read", async () => {
    db.recordBotConversationActsFor(PULLED_ROOT, { actsFor: OWNER })
    pulledRequestTo(PULLED_ROOT)
    // The provenance read fails; the turn read after it succeeds.
    unreadableOnce.add(PULLED_ROOT)

    expect((await readBotTurn(runtime, db, PULLED_ROOT)).actsFor).toEqual([{ kind: 'unknown' }])
  })
})
