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
  sessionId: 'blob-tail-retention',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-blob-tail-retention-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('compaction blob tail retention', () => {
  it('keeps blobs for both a retained old revision and the live revision', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      compaction: { minTailRows: 2, retainTailMs: 0 },
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    const identity = {
      provider: 'codex' as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      ordinal: 0
    }
    const appendRevision = async (payload: string): Promise<string> => {
      const output = boundPayload(payload, limits)
      const body: AgentJournalItemBody = {
        kind: 'tool-call',
        name: 'large-output',
        input: null,
        state: 'completed',
        output
      }
      await journal.appendItem(identity, body, {
        fence: 1,
        blobs: [{ digest: output.digest, payload }]
      })
      return output.digest
    }

    const payloadA = 'revision-a'.repeat(512)
    const payloadB = 'revision-b'.repeat(512)
    const digestA = await appendRevision(payloadA)
    const digestB = await appendRevision(payloadB)
    await journal.compact()

    const resumed = journal.readSince({ epoch: journal.epoch, sequence: 1 })
    expect(resumed.ok && resumed.rows).toHaveLength(2)
    expect(await readJournalBlob(root, digestA)).toBe(payloadA)
    expect(await readJournalBlob(root, digestB)).toBe(payloadB)
  })
})
