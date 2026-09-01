// Legacy import runs the existing per-agent transcript decoders and keys the
// results by identity read off the same raw lines. Fixtures are shaped like the
// files the providers actually write.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { JOURNAL_BLOB_DIR, readJournalBlob } from './journal-blob-store'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import {
  appendLegacyTranscriptMessages,
  importLegacyTranscriptIntoJournal
} from './journal-legacy-import'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { openAgentSessionJournal } from './journal-store-factory'
import type { AgentSessionJournal } from './journal-store'

const CLAUDE_SESSION = '29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88'
const CODEX_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function identity(agent: 'claude' | 'codex', sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent,
    providerHandle:
      agent === 'claude'
        ? { kind: 'claude', sessionId, leafUuid: null }
        : { kind: 'codex', threadId: sessionId }
  }
}

async function open(
  agent: 'claude' | 'codex',
  sessionId: string,
  overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}
): Promise<AgentSessionJournal> {
  return openAgentSessionJournal({
    identity: identity(agent, sessionId),
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

function legacyKey(recordId: string): string {
  return agentJournalItemKey({
    provider: 'legacy',
    agent: 'codex',
    sessionId: CODEX_SESSION,
    recordId
  })
}

async function writeFixture(name: string, lines: unknown[]): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
  return path
}

const CLAUDE_LINES = [
  { type: 'file-history-snapshot', messageId: 'boot', snapshot: {} },
  {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'add a retry' }] },
    uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04',
    timestamp: '2026-08-05T10:00:00.000Z',
    cwd: '/Users/dev/project',
    sessionId: CLAUDE_SESSION,
    version: '2.1.220',
    gitBranch: 'main'
  },
  {
    parentUuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04',
    isSidechain: false,
    type: 'assistant',
    requestId: 'req_01',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'On it.' }],
      id: 'msg_ignored_in_favour_of_uuid'
    },
    uuid: 'b7c9e1f2-8a30-4d55-91ab-6f0e2c4d8b11',
    timestamp: '2026-08-05T10:00:04.000Z',
    sessionId: CLAUDE_SESSION,
    version: '2.1.220'
  },
  {
    parentUuid: 'b7c9e1f2-8a30-4d55-91ab-6f0e2c4d8b11',
    isSidechain: false,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'Edit', input: { file_path: 'a.ts' } }]
    },
    uuid: 'd2f4a6b8-1c02-4e77-83bd-5a9c7e1f3d20',
    timestamp: '2026-08-05T10:00:07.000Z',
    sessionId: CLAUDE_SESSION
  },
  {
    parentUuid: 'd2f4a6b8-1c02-4e77-83bd-5a9c7e1f3d20',
    isSidechain: false,
    isMeta: true,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'edited 1 file' }]
    },
    uuid: 'e3a5b7c9-2d13-4f88-94ce-6b0d8f2a4e31',
    timestamp: '2026-08-05T10:00:08.000Z',
    sessionId: CLAUDE_SESSION
  },
  { type: 'last-prompt', leafUuid: 'e3a5b7c9-2d13-4f88-94ce-6b0d8f2a4e31' }
]

// Shapes taken from a real rollout file: `event_msg` records carry no id, and
// `response_item` records do — which is exactly the split the tracker handles.
const CODEX_LINES = [
  {
    type: 'session_meta',
    timestamp: '2026-08-05T10:00:00.000Z',
    payload: {
      id: CODEX_SESSION,
      session_id: CODEX_SESSION,
      cwd: '/Users/dev/project',
      originator: 'codex_cli_rs',
      cli_version: '0.146.1'
    }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:01.000Z',
    payload: { type: 'task_started', turn_id: '019fd8ca-edbe-7c43-b231-4c7aea3a2d89' }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:02.000Z',
    payload: { type: 'user_message', message: 'add a retry', kind: 'plain' }
  },
  {
    type: 'response_item',
    timestamp: '2026-08-05T10:00:04.000Z',
    payload: {
      type: 'reasoning',
      id: 'rs_06235749b04250a3016a7404b3a25c8199b882f2f8288fefd0',
      summary: [{ type: 'summary_text', text: 'Checking the retry policy.' }]
    }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:05.000Z',
    payload: { type: 'agent_message', message: 'On it.' }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:06.000Z',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 12 } } }
  }
]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-import-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('claude import', () => {
  it('keys items by (session id, uuid) from the raw record', async () => {
    const filePath = await writeFixture('claude.jsonl', CLAUDE_LINES)
    const journal = await open('claude', CLAUDE_SESSION)
    const result = await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath }
    })

    expect(result.ok).toBe(true)
    expect(journal.snapshot().items.map((entry) => entry.itemId)).toEqual([
      agentJournalItemKey({
        provider: 'claude',
        sessionId: CLAUDE_SESSION,
        uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
      }),
      agentJournalItemKey({
        provider: 'claude',
        sessionId: CLAUDE_SESSION,
        uuid: 'b7c9e1f2-8a30-4d55-91ab-6f0e2c4d8b11'
      }),
      agentJournalItemKey({
        provider: 'claude',
        sessionId: CLAUDE_SESSION,
        uuid: 'd2f4a6b8-1c02-4e77-83bd-5a9c7e1f3d20'
      }),
      agentJournalItemKey({
        provider: 'claude',
        sessionId: CLAUDE_SESSION,
        uuid: 'e3a5b7c9-2d13-4f88-94ce-6b0d8f2a4e31'
      })
    ])
  })

  it('stays aligned when the decoder drops lines the tracker still walks', async () => {
    const filePath = await writeFixture('claude.jsonl', CLAUDE_LINES)
    const journal = await open('claude', CLAUDE_SESSION)
    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath }
    })
    const items = journal.snapshot().items
    // The first record is a file-history snapshot the decoder discards; if the
    // anchors were misaligned, the first bubble would carry its identity.
    expect(items[0]?.body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'add a retry' }]
    })
    expect(items[2]?.body).toMatchObject({ kind: 'tool-call', name: 'Edit' })
  })

  it('is idempotent: a second import reproduces the same timeline in a new epoch', async () => {
    const filePath = await writeFixture('claude.jsonl', CLAUDE_LINES)
    const journal = await open('claude', CLAUDE_SESSION)
    const options = { filePath }
    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options
    })
    const first = journal.snapshot()
    const firstEpoch = journal.epoch

    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options
    })
    const second = journal.snapshot()

    expect(journal.epoch).not.toBe(firstEpoch)
    expect(second.items.map((entry) => entry.itemId)).toEqual(
      first.items.map((entry) => entry.itemId)
    )
    expect(second.items.map((entry) => entry.body)).toEqual(first.items.map((entry) => entry.body))
  })

  it('reconciles a forked transcript onto the parent uuids rather than duplicating them', () => {
    const tracker = createLegacyIdentityTracker({
      transcriptAgent: 'claude',
      agent: 'claude',
      // The fork's own session id, which is NOT what the copied records carry.
      sessionId: '7b1e5d33-0f28-42ac-8d59-9a4c6e2b1f70'
    })
    const copied = JSON.stringify(CLAUDE_LINES[1])
    expect(tracker.identify(copied, 0)).toEqual({
      provider: 'claude',
      sessionId: CLAUDE_SESSION,
      uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    })
  })
})

describe('codex import', () => {
  it('upserts live transcript messages without rolling the structured epoch', async () => {
    const journal = await open('codex', CODEX_SESSION)
    const epoch = journal.epoch
    const message = {
      id: 'live-tui-message',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'first version' }],
      timestamp: 1_800_000_000_000,
      source: 'transcript' as const
    }

    await appendLegacyTranscriptMessages({
      journal,
      agent: 'codex',
      sessionId: CODEX_SESSION,
      fence: 2,
      messages: [message]
    })
    await appendLegacyTranscriptMessages({
      journal,
      agent: 'codex',
      sessionId: CODEX_SESSION,
      fence: 2,
      messages: [{ ...message, blocks: [{ type: 'text', text: 'final version' }] }]
    })

    expect(journal.epoch).toBe(epoch)
    expect(journal.snapshot().items).toMatchObject([
      {
        itemId: legacyKey('live-tui-message'),
        revision: 2,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'final version' }]
        }
      }
    ])
  })

  it('keys rollout records in the import-scoped namespace, not as app-server ordinals', async () => {
    const filePath = await writeFixture('rollout.jsonl', CODEX_LINES)
    const journal = await open('codex', CODEX_SESSION)
    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'codex',
      sessionId: CODEX_SESSION,
      fence: 1,
      options: { filePath }
    })

    // A rollout record with its own id keeps it; an `event_msg` has none, so it
    // falls back to its line position — deterministic for a given file.
    expect(journal.snapshot().items.map((entry) => entry.itemId)).toEqual([
      legacyKey('#2'),
      legacyKey('rs_06235749b04250a3016a7404b3a25c8199b882f2f8288fefd0'),
      legacyKey('#4')
    ])
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
      {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'Checking the retry policy.' }]
      },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'On it.' }] }
    ])
  })

  it('survives a resumed rollout that renumbers positional item ids', () => {
    const tracker = createLegacyIdentityTracker({
      transcriptAgent: 'codex',
      agent: 'codex',
      sessionId: CODEX_SESSION
    })
    const original = tracker.identify(JSON.stringify(CODEX_LINES[3]), 4)
    // Same record replayed at a different position in a resumed file.
    const replayed = tracker.identify(JSON.stringify(CODEX_LINES[3]), 11)
    expect(replayed).toEqual(original)
    expect(original).toMatchObject({
      recordId: 'rs_06235749b04250a3016a7404b3a25c8199b882f2f8288fefd0'
    })
  })

  it('falls back to line position only when a record carries no id', () => {
    const tracker = createLegacyIdentityTracker({
      transcriptAgent: 'codex',
      agent: 'codex',
      sessionId: CODEX_SESSION
    })
    expect(tracker.identify(JSON.stringify({ type: 'event_msg', payload: {} }), 3)).toEqual({
      provider: 'legacy',
      agent: 'codex',
      sessionId: CODEX_SESSION,
      recordId: '#3'
    })
  })
})

describe('payload bounds on import', () => {
  it('marks a clipped tool result and parks the remainder in the blob store', async () => {
    const output = 'y'.repeat(64 * 1024)
    const filePath = await writeFixture('claude-big.jsonl', [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: output }]
        },
        uuid: 'aa11bb22-cc33-4d44-8e55-6f7788990011',
        timestamp: '2026-08-05T10:00:09.000Z',
        sessionId: CLAUDE_SESSION
      }
    ])
    const journal = await open('claude', CLAUDE_SESSION)
    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath, limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 1_024 } }
    })

    const item = journal.snapshot().items[0]
    expect(item?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    const body = item?.body
    if (body?.kind !== 'tool-call' || !body.output) {
      throw new Error('expected a bounded tool-call output')
    }
    expect(body.output.truncated).toBe(true)
    expect(body.output.byteLength).toBe(64 * 1024)
    expect(body.output.head).toHaveLength(1_024)
    expect(await readJournalBlob(root, body.output.digest)).toBe(output)
  })

  it('deduplicates staged blobs while importing a replacement epoch', async () => {
    const journalDir = join(root, 'dedupe-journal')
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 512,
      maxSessionBytes: 512 * 1024
    }
    const output = 'd'.repeat(32 * 1024)
    const bounded = boundPayload(output, limits)
    const toolResultLine = (uuid: string) => ({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `toolu_${uuid}`, content: output }]
      },
      uuid,
      timestamp: '2026-08-05T10:00:09.000Z',
      sessionId: CLAUDE_SESSION
    })
    const filePath = await writeFixture('claude-duplicate-blobs.jsonl', [
      toolResultLine('aa11bb22-cc33-4d44-8e55-6f7788990011'),
      toolResultLine('bb22cc33-dd44-4e55-8f66-778899001122')
    ])
    const journal = await open('claude', CLAUDE_SESSION, {
      journalDir,
      limits,
      autoCompact: false
    })

    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath, limits }
    })

    expect(await readJournalBlob(journalDir, bounded.digest)).toBe(output)
    expect(await readdir(join(journalDir, JOURNAL_BLOB_DIR))).toEqual([bounded.digest])
    expect(
      journal
        .snapshot()
        .items.map((item) => (item.body.kind === 'tool-call' ? item.body.output?.digest : null))
    ).toEqual([bounded.digest, bounded.digest])
  })

  it('prunes root-level blobs made stale by a later legacy import', async () => {
    const journalDir = join(root, 'prune-journal')
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 512,
      maxSessionBytes: 512 * 1024
    }
    const output = 's'.repeat(32 * 1024)
    const bounded = boundPayload(output, limits)
    const first = await writeFixture('claude-stale-blob.jsonl', [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_stale', content: output }]
        },
        uuid: 'aa11bb22-cc33-4d44-8e55-6f7788990011',
        timestamp: '2026-08-05T10:00:09.000Z',
        sessionId: CLAUDE_SESSION
      }
    ])
    const second = await writeFixture('claude-without-blob.jsonl', [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'replacement' }] },
        uuid: 'cc33dd44-ee55-4666-8777-889900112233',
        timestamp: '2026-08-05T10:00:10.000Z',
        sessionId: CLAUDE_SESSION
      }
    ])
    const journal = await open('claude', CLAUDE_SESSION, {
      journalDir,
      limits,
      autoCompact: false
    })

    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath: first, limits }
    })
    expect(await readJournalBlob(journalDir, bounded.digest)).toBe(output)

    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 2,
      options: { filePath: second, limits }
    })

    expect(await readJournalBlob(journalDir, bounded.digest)).toBeNull()
    expect(journal.snapshot().items[0]?.body).toMatchObject({
      kind: 'message',
      blocks: [{ type: 'text', text: 'replacement' }]
    })
  })

  it('uses managed catch-up appends when a tool-result blob exceeds quota', async () => {
    const journalDir = join(root, 'catchup-journal')
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 128,
      maxSessionBytes: 8_000
    }
    const journal = await open('codex', CODEX_SESSION, {
      journalDir,
      limits,
      autoCompact: false
    })
    const output = 'z'.repeat(12_000)
    const bounded = boundPayload(output, limits)

    await expect(
      appendLegacyTranscriptMessages({
        journal,
        agent: 'codex',
        sessionId: CODEX_SESSION,
        fence: 1,
        messages: [
          {
            id: 'catchup-tool-output',
            role: 'tool',
            blocks: [{ type: 'tool-result', output }],
            timestamp: 1_800_000_000_000,
            source: 'transcript'
          }
        ]
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(await readJournalBlob(journalDir, bounded.digest)).toBeNull()
    expect(journal.snapshot().items).toEqual([])
  })
})

describe('import failures', () => {
  it('rejects a legacy source above the fixed 16 MiB import cap before decoding', async () => {
    const journalDir = join(root, 'oversized-source-journal')
    const journal = await open('claude', CLAUDE_SESSION, {
      journalDir,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 256 * 1024 * 1024 },
      autoCompact: false
    })
    const filePath = join(root, 'oversized-source.jsonl')
    await writeFile(filePath, 'x'.repeat(16 * 1024 * 1024 + 1), 'utf8')
    const epoch = journal.epoch

    await expect(
      importLegacyTranscriptIntoJournal({
        journal,
        agent: 'claude',
        sessionId: CLAUDE_SESSION,
        fence: 1,
        options: { filePath }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: `Legacy transcript exceeds the ${16 * 1024 * 1024}-byte import bound`
    })
    expect(journal.epoch).toBe(epoch)
    expect(journal.snapshot().items).toEqual([])
  })

  it('keeps the live epoch intact when a staged rebuild runs out of budget', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 }
    const journal = await open('codex', CODEX_SESSION, { limits })
    await appendLegacyTranscriptMessages({
      journal,
      agent: 'codex',
      sessionId: CODEX_SESSION,
      fence: 1,
      messages: [
        {
          id: 'durable-prefix',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'keep me' }],
          timestamp: 1_800_000_000_000,
          source: 'transcript'
        }
      ]
    })
    const filePath = await writeFixture('oversized-rollout.jsonl', [
      CODEX_LINES[0],
      CODEX_LINES[1],
      CODEX_LINES[2],
      {
        type: 'event_msg',
        timestamp: '2026-08-05T10:00:03.000Z',
        payload: { type: 'agent_message', message: 'x'.repeat(2_000) }
      }
    ])
    const epoch = journal.epoch
    const snapshotPath = join(root, 'snapshot.json')
    const logPath = join(root, 'log.jsonl')
    const before = {
      snapshot: await readFile(snapshotPath, 'utf-8'),
      log: await readFile(logPath, 'utf-8')
    }

    await expect(
      importLegacyTranscriptIntoJournal({
        journal,
        agent: 'codex',
        sessionId: CODEX_SESSION,
        fence: 1,
        options: { filePath, limits }
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(journal.epoch).toBe(epoch)
    expect(await readFile(snapshotPath, 'utf-8')).toBe(before.snapshot)
    expect(await readFile(logPath, 'utf-8')).toBe(before.log)
    expect(journal.snapshot().items[0]?.body).toMatchObject({
      kind: 'message',
      blocks: [{ type: 'text', text: 'keep me' }]
    })
  })

  it('cleans staged replacement blobs when legacy import exceeds physical quota', async () => {
    const journalDir = join(root, 'replacement-journal')
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 128,
      maxSessionBytes: 8_000
    }
    const journal = await open('claude', CLAUDE_SESSION, {
      journalDir,
      limits,
      autoCompact: false
    })
    const output = 'q'.repeat(12_000)
    const bounded = boundPayload(output, limits)
    const filePath = await writeFixture('oversized-tool-result.jsonl', [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_oversized', content: output }]
        },
        uuid: 'ba11ad00-1111-4222-8333-444455556666',
        timestamp: '2026-08-05T10:00:09.000Z',
        sessionId: CLAUDE_SESSION
      }
    ])
    const epoch = journal.epoch

    await expect(
      importLegacyTranscriptIntoJournal({
        journal,
        agent: 'claude',
        sessionId: CLAUDE_SESSION,
        fence: 1,
        options: { filePath, limits }
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(journal.epoch).toBe(epoch)
    expect(await readJournalBlob(journalDir, bounded.digest)).toBeNull()
    expect((await readdir(journalDir)).some((name) => name.startsWith('.epoch-replacement-'))).toBe(
      false
    )
  })

  it('bounds oversized legacy tool-call input before journal publication', async () => {
    const journalDir = join(root, 'bounded-tool-input-journal')
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 64 }
    const journal = await open('claude', CLAUDE_SESSION, {
      journalDir,
      limits,
      autoCompact: false
    })
    const filePath = await writeFixture('oversized-tool-input.jsonl', [
      {
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_large_input',
              name: 'Edit',
              input: { file_path: 'a.ts', patch: 'x'.repeat(10_000) }
            }
          ]
        },
        uuid: 'cc11ad00-1111-4222-8333-444455556666',
        timestamp: '2026-08-05T10:00:09.000Z',
        sessionId: CLAUDE_SESSION
      }
    ])

    const result = await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath, limits }
    })
    expect(result.ok).toBe(true)
    const imported = journal.snapshot().items[0]
    expect(imported?.body).toMatchObject({
      kind: 'tool-call',
      input: {
        truncated: true,
        byteLength: expect.any(Number),
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        head: expect.any(String)
      }
    })
    expect(JSON.stringify(imported?.body)).not.toContain('x'.repeat(1_000))
  })

  it('reports a missing transcript without touching the journal', async () => {
    const journal = await open('claude', CLAUDE_SESSION)
    const before = journal.epoch
    const result = await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'claude',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath: join(root, 'missing.jsonl') }
    })
    expect(result).toMatchObject({ ok: false })
    expect(journal.epoch).toBe(before)
  })

  it('rejects an agent with no transcript decoder', async () => {
    const journal = await open('claude', CLAUDE_SESSION)
    const result = await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'gemini',
      sessionId: CLAUDE_SESSION,
      fence: 1,
      options: { filePath: join(root, 'claude.jsonl') }
    })
    expect(result).toMatchObject({ ok: false })
  })
})
