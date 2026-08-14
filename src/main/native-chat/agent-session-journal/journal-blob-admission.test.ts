import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { readJournalBlob } from './journal-blob-store'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  digestPayload
} from './journal-payload-bounds'
import { journalStorageFootprint } from './journal-storage-footprint'
import { openAgentSessionJournal } from './journal-store'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'blob-admission-session',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-blob-admission-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function blobNames(): Promise<string[]> {
  try {
    return await readdir(join(root, 'blobs'))
  } catch {
    return []
  }
}

describe('journal blob admission', () => {
  it('rejects a blob whose digest is not bound to its payload', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    await expect(
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
        {
          kind: 'tool-call',
          name: 'bad-output',
          input: null,
          state: 'completed',
          output: { head: '', byteLength: 15, digest: '0'.repeat(64), truncated: true }
        },
        { fence: 1, blobs: [{ digest: '0'.repeat(64), payload: 'different bytes' }] }
      )
    ).rejects.toThrow('does not match its payload')
    expect(await blobNames()).toHaveLength(0)
  })

  it('rejects missing and unreferenced blob attachments', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    const payload = 'bounded output'
    const digest = digestPayload(payload)
    const identity = {
      provider: 'codex' as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      ordinal: 0
    }
    await expect(
      journal.appendItem(
        identity,
        {
          kind: 'tool-call',
          name: 'missing-output',
          input: null,
          state: 'completed',
          output: { head: '', byteLength: payload.length, digest, truncated: true }
        },
        { fence: 1 }
      )
    ).rejects.toThrow('references missing blob')
    await expect(
      journal.appendItem(
        identity,
        { kind: 'message', role: 'assistant', blocks: [] },
        {
          fence: 1,
          blobs: [{ digest, payload }]
        }
      )
    ).rejects.toThrow('not referenced by its row')
  })

  it('fails closed when the blob store cannot be enumerated', async () => {
    await writeFile(join(root, 'blobs'), 'not a directory', 'utf8')
    await expect(
      openAgentSessionJournal({
        identity: IDENTITY,
        journalDir: root,
        now: () => (clock += 1),
        mintEpoch: () => 'epoch-1'
      })
    ).rejects.toThrow('blob store is not a directory')
  })

  it.runIf(process.platform !== 'win32')('does not follow a blob symlink', async () => {
    const payload = 'outside journal data'
    const digest = digestPayload(payload)
    const outside = join(root, 'outside')
    await writeFile(outside, payload, 'utf8')
    await mkdir(join(root, 'blobs'))
    await symlink(outside, join(root, 'blobs', digest))

    await expect(readJournalBlob(root, digest)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('counts crash-left root temp bytes after opening a new journal', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 }
    await writeFile(join(root, 'snapshot.json.99.1.dead.tmp'), 'x'.repeat(1_900), 'utf8')
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })

    await expect(
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
        { kind: 'message', role: 'assistant', blocks: [] },
        { fence: 1 }
      )
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it.each([
    { name: 'crash-left blob temp', file: `${'a'.repeat(64)}.99.1.dead.tmp` },
    { name: 'finalized orphan blob', file: digestPayload('x'.repeat(1_900)) }
  ])('counts a $name after reopen', async ({ file }) => {
    await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    await mkdir(join(root, 'blobs'), { recursive: true })
    await writeFile(join(root, 'blobs', file), 'x'.repeat(1_900), 'utf8')
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 },
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })

    await expect(
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
        { kind: 'message', role: 'assistant', blocks: [] },
        { fence: 1 }
      )
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('does not reset the physical quota to the retained tail after compaction', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 6_000 }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      compaction: { minTailRows: 1, retainTailMs: 0 },
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    let rejection: unknown = null
    for (let ordinal = 0; ordinal < 30; ordinal += 1) {
      try {
        await journal.appendItem(
          { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'x'.repeat(500) }] },
          { fence: 1 }
        )
        await journal.compact()
      } catch (error) {
        rejection = error
        break
      }
    }

    expect(rejection).toMatchObject({ code: 'journal_bound_exceeded' })
    expect(await journalStorageFootprint(root)).toBeGreaterThan(0)
  })

  it('uses trusted host time for rate admission instead of provider observedAt', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: {
        ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
        maxAppendsPerWindow: 1,
        appendWindowMs: 60_000
      },
      now: () => 1_000,
      mintEpoch: () => 'epoch-1'
    })
    const append = (ordinal: number, observedAt: number) =>
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
        { kind: 'message', role: 'assistant', blocks: [] },
        { fence: 1, observedAt }
      )

    await append(0, 60_000)
    await expect(append(1, 120_000)).rejects.toMatchObject({ code: 'journal_rate_exceeded' })
  })

  it.each([
    {
      name: 'session byte quota',
      limits: { maxSessionBytes: 20 * 1024, maxAppendsPerWindow: 10 },
      code: 'journal_bound_exceeded'
    },
    {
      name: 'append rate quota',
      limits: { maxSessionBytes: 1024 * 1024, maxAppendsPerWindow: 1 },
      code: 'journal_rate_exceeded'
    }
  ])('does not persist unique payloads rejected by the $name', async ({ limits, code }) => {
    const journalLimits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      ...limits,
      inlineHeadBytes: 8,
      appendWindowMs: 60_000
    }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: journalLimits,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    const errors: unknown[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => errors.push(error)
    })
    deferred.bind({ journal, fence: 1, publish: () => {} })

    const append = (ordinal: number, payload: string): void => {
      const output = boundPayload(payload, journalLimits)
      const body: AgentJournalItemBody = {
        kind: 'tool-call',
        name: 'large-output',
        input: null,
        state: 'completed',
        output
      }
      deferred.sink.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
        body,
        [{ digest: output.digest, payload }]
      )
    }

    append(0, 'accepted'.repeat(1_536))
    await deferred.drained()
    expect(errors).toHaveLength(0)
    expect(await blobNames()).toHaveLength(1)

    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      append(ordinal, `rejected-${ordinal}`.repeat(1_024))
      await deferred.drained()
      expect(errors.at(-1)).toMatchObject({ code })
    }
    expect(errors).toHaveLength(3)
    expect(await blobNames()).toHaveLength(1)
  })
})
