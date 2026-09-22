import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { boundInlineText, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryFor } from './journal-paths'
import { createTrackedJournalOpener } from './journal-store-test-open'
import {
  JournalPayloadStore,
  PAYLOAD_STORE_DIR_NAME,
  setDefaultJournalPayloadRetention
} from './journal-payload-store'
import { collectJournalRowPayloadDigests } from '../../../shared/journal-payload-reference'
import {
  journalReferencesDigest,
  PayloadReadError,
  readSessionPayload
} from './journal-payload-read'

const OWNER: AgentSessionJournalIdentity = {
  sessionId: 'session-owner',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-owner' }
}
const STRANGER: AgentSessionJournalIdentity = { ...OWNER, sessionId: 'session-stranger' }

function recordFor(identity: AgentSessionJournalIdentity): {
  sessionId: string
  workspaceId: string
} {
  return { sessionId: identity.sessionId, workspaceId: identity.workspaceId }
}

function longOutput(): string {
  const lines: string[] = ['CONSTRAINT-A at the top']
  while (Buffer.byteLength(lines.join('\n'), 'utf8') < 40_000) {
    lines.push(`tool output ${lines.length} ääkköset 🧩 ${'y'.repeat(50)}`)
  }
  lines.push('CONSTRAINT-C past the 16 KiB head')
  return lines.join('\n')
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
const tick = (): number => (clock += 1)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-payload-read-'))
  setDefaultJournalPayloadRetention(
    new JournalPayloadStore({ directory: join(root, PAYLOAD_STORE_DIR_NAME) })
  )
})
afterEach(async () => {
  setDefaultJournalPayloadRetention(null)
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function writeToolOutput(identity: AgentSessionJournalIdentity, output: string) {
  const journal = await journals.open({
    identity,
    journalDir: journalDirectoryFor(root, {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId
    }),
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
  // The exact production bounding call: head on the row, original retained.
  const bounded = boundInlineText(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
  const item: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: 'thread-owner',
    turnId: 'turn-1',
    ordinal: 0
  }
  const body: AgentJournalItemBody = {
    kind: 'tool-call',
    name: 'Bash',
    input: { command: 'cat artifact.md' },
    state: 'completed',
    output: bounded
  }
  await journal.appendItem(item, body, { fence: 1 })
  await journal.close()
  return bounded
}

async function appendBody(identity: AgentSessionJournalIdentity, body: AgentJournalItemBody) {
  const journal = await journals.open({
    identity,
    journalDir: journalDirectoryFor(root, {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId
    }),
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
  const item: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: `thread-${identity.sessionId}`,
    turnId: 'turn-1',
    ordinal: 0
  }
  await journal.appendItem(item, body, { fence: 1 })
  await journal.close()
}

/** A tool call whose model-authored input names `digest` — the forgery the
 *  structural check exists to refuse. */
async function writeToolCallInput(identity: AgentSessionJournalIdentity, input: unknown) {
  await appendBody(identity, { kind: 'tool-call', name: 'Bash', input, state: 'completed' })
}

/** A message block clipped by the legacy import path: the reference lives in
 *  `clipped`, beside the head, which is a position Orca itself writes. */
async function writeClippedMessageBlock(identity: AgentSessionJournalIdentity, output: string) {
  const bounded = boundInlineText(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
  await appendBody(identity, {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: bounded.head,
        clipped: {
          digest: bounded.digest,
          byteLength: bounded.byteLength,
          retrievable: bounded.retrievable === true
        }
      }
    ]
  })
  return bounded
}

/** A provider-frame status row as `unhandled-provider-frame.ts` writes it: the
 *  reference lives on `providerFrame.payload`, beside the display text. */
async function writeStatusProviderFrame(identity: AgentSessionJournalIdentity, payload: string) {
  const bounded = boundInlineText(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
  await appendBody(identity, {
    kind: 'status',
    text: bounded.head,
    providerFrame: { provider: 'codex', kind: 'notification:warning', payload: bounded }
  })
  return bounded
}

describe('owner-checked payload read through a real journal', () => {
  it('serves the complete original to the session whose journal references it', async () => {
    const output = longOutput()
    const bounded = await writeToolOutput(OWNER, output)
    expect(bounded).toMatchObject({ truncated: true, retrievable: true })
    expect(bounded.head).not.toContain('CONSTRAINT-C')
    const parts: string[] = []
    let offset = 0
    for (;;) {
      const range = readSessionPayload({
        journalRoot: root,
        owner: recordFor(OWNER),
        digest: bounded.digest,
        offset,
        limit: 9_000,
        maxLimit: 256 * 1024
      })
      parts.push(range.chunk)
      offset = range.chunkOffset + range.chunkByteLength
      if (range.complete) {
        break
      }
    }
    const retrieved = parts.join('')
    expect(retrieved).toBe(output)
    expect(retrieved).toContain('CONSTRAINT-C past the 16 KiB head')
    expect(Buffer.byteLength(retrieved, 'utf8')).toBe(bounded.byteLength)
  })

  it('refuses a session that never referenced the digest, even though the bytes exist', async () => {
    const bounded = await writeToolOutput(OWNER, longOutput())
    await writeToolOutput(STRANGER, 'short unrelated output')
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(STRANGER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
    // A session with no journal at all is refused the same way.
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor({ ...OWNER, sessionId: 'session-unknown' }),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
  })

  it('refuses a tampered retained file and reports it as an integrity failure', async () => {
    const bounded = await writeToolOutput(OWNER, longOutput())
    await writeFile(join(root, PAYLOAD_STORE_DIR_NAME, `${bounded.digest}.payload`), 'tampered')
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(OWNER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_integrity_failed' }))
  })

  it('reports a host without retention as not retained before touching any journal', async () => {
    const bounded = await writeToolOutput(OWNER, longOutput())
    setDefaultJournalPayloadRetention(null)
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(OWNER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_retained' }))
  })

  it('refuses a foreign digest a session merely echoed into its own tool input', async () => {
    const bounded = await writeToolOutput(OWNER, longOutput())
    // The stranger's row carries the owner's digest in a field the MODEL wrote.
    await writeToolCallInput(STRANGER, { note: 'look at this', digest: bounded.digest })
    const strangerDir = journalDirectoryFor(root, {
      workspaceId: STRANGER.workspaceId,
      sessionId: STRANGER.sessionId
    })
    expect(journalReferencesDigest(strangerDir, STRANGER.sessionId, bounded.digest)).toBe(false)
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(STRANGER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
    // The same digest still reads for the session that genuinely retained it.
    expect(
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(OWNER),
        digest: bounded.digest,
        limit: 64,
        maxLimit: 256 * 1024
      }).byteLength
    ).toBe(bounded.byteLength)
  })

  it('admits a clip reference a message block carries, and refuses the same digest elsewhere', async () => {
    const output = longOutput()
    const bounded = await writeClippedMessageBlock(OWNER, output)
    const ownerDir = journalDirectoryFor(root, {
      workspaceId: OWNER.workspaceId,
      sessionId: OWNER.sessionId
    })
    expect(journalReferencesDigest(ownerDir, OWNER.sessionId, bounded.digest)).toBe(true)
    const range = readSessionPayload({
      journalRoot: root,
      owner: recordFor(OWNER),
      digest: bounded.digest,
      limit: 256 * 1024,
      maxLimit: 256 * 1024
    })
    expect(range.chunk).toContain('CONSTRAINT-A at the top')

    // A session that only ever saw the digest is still refused.
    await writeToolOutput(STRANGER, 'short unrelated output')
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(STRANGER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
  })

  it('admits a provider-frame reference a status row carries', async () => {
    const output = longOutput()
    const bounded = await writeStatusProviderFrame(OWNER, output)
    const ownerDir = journalDirectoryFor(root, {
      workspaceId: OWNER.workspaceId,
      sessionId: OWNER.sessionId
    })
    expect(journalReferencesDigest(ownerDir, OWNER.sessionId, bounded.digest)).toBe(true)
    const range = readSessionPayload({
      journalRoot: root,
      owner: recordFor(OWNER),
      digest: bounded.digest,
      limit: 256 * 1024,
      maxLimit: 256 * 1024
    })
    expect(range.chunk).toContain('CONSTRAINT-C past the 16 KiB head')

    // A session that only ever saw the digest is still refused.
    await writeToolOutput(STRANGER, 'short unrelated output')
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(STRANGER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
  })

  it('keeps small payloads inline: no reference, no retrieval', async () => {
    const bounded = await writeToolOutput(OWNER, 'small output')
    expect(bounded.truncated).toBe(false)
    const journalDir = journalDirectoryFor(root, {
      workspaceId: OWNER.workspaceId,
      sessionId: OWNER.sessionId
    })
    expect(journalReferencesDigest(journalDir, OWNER.sessionId, bounded.digest)).toBe(true)
    expect(() =>
      readSessionPayload({
        journalRoot: root,
        owner: recordFor(OWNER),
        digest: bounded.digest,
        maxLimit: 256 * 1024
      })
    ).toThrow(PayloadReadError)
  })
})

describe('reference collection across row shapes', () => {
  const DIGEST = 'c'.repeat(64)
  const reference = { head: 'head', byteLength: 40_000, truncated: true, digest: DIGEST }

  it('admits a completed tool-call body carried in a lifecycle batch', () => {
    // A settlement path may carry a finished tool call under `mutations[].body`
    // instead of the row's own `body`; its output is the session's own payload.
    expect(
      collectJournalRowPayloadDigests({
        kind: 'lifecycle-batch',
        settlementId: 's1',
        mutations: [
          { kind: 'tombstone', itemId: 'i0', revision: 1 },
          {
            kind: 'item',
            itemId: 'i1',
            revision: 1,
            body: {
              kind: 'tool-call',
              name: 'Bash',
              input: {},
              state: 'completed',
              output: reference
            }
          }
        ]
      })
    ).toEqual(new Set([DIGEST]))
  })

  it('still refuses a digest a batch only echoes back through tool input', () => {
    expect(
      collectJournalRowPayloadDigests({
        kind: 'lifecycle-batch',
        settlementId: 's1',
        mutations: [
          {
            kind: 'item',
            itemId: 'i1',
            revision: 1,
            body: { kind: 'tool-call', name: 'Bash', input: reference, state: 'completed' }
          }
        ]
      }).size
    ).toBe(0)
    // A `mutations` field that is not an array of bodies references nothing.
    expect(collectJournalRowPayloadDigests({ mutations: 'not-an-array' }).size).toBe(0)
    expect(
      collectJournalRowPayloadDigests({ mutations: [null, 7, { body: reference }] }).size
    ).toBe(0)
  })
})
