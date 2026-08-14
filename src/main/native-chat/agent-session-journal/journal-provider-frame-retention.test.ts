import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { readJournalBlob } from './journal-blob-store'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { openAgentSessionJournal } from './journal-store'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'provider-frame-retention',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-frame-retention-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('provider-frame blob retention', () => {
  it('keeps a truncated live provider frame through compaction', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    const payload = JSON.stringify({ image: 'x'.repeat(4_096) })
    const bounded = boundPayload(payload, limits)
    const body: AgentJournalItemBody = {
      kind: 'status',
      text: 'provider · notification',
      providerFrame: {
        provider: 'provider',
        kind: 'notification',
        payload: bounded
      }
    }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      compaction: { minTailRows: 1, retainTailMs: 0 },
      mintEpoch: () => 'epoch-1'
    })

    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      body,
      { fence: 1, blobs: [{ digest: bounded.digest, payload }] }
    )
    await journal.compact()

    expect(await readJournalBlob(root, bounded.digest)).toBe(payload)
  })
})
