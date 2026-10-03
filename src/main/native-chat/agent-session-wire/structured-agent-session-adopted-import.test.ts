import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Adoption happens at the at-rest create: the source is validated before a record claims the provider
// conversation, and no agent starts.

import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import * as legacyImport from '../agent-session-journal/journal-legacy-import'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const NOW = 1_800_000_000_000
const SESSION = 'codex_adopting_session'
const THREAD = 'adopted-thread'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null
let store: AgentSessionRecordStore | null = null
let host: StructuredAgentSessionHost | null = null

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = null
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
  store = null
  vi.restoreAllMocks()
})

/** A minimal Codex rollout the legacy transcript decoder can read back. */
async function writeCodexRollout(path: string, text: string): Promise<void> {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: THREAD, timestamp: '2026-09-06T18:00:00.000Z', cwd: '/workspace' }
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-06T18:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: text
      }
    })
  ]
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function attachParams(transcriptPath?: string): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    adopt: {
      providerHandle: { kind: 'codex', threadId: THREAD },
      ...(transcriptPath ? { transcriptPath } : {})
    }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'resumed-link',
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

async function openHost(sessionAdapter: StructuredAgentSessionAdapter) {
  store ??= await openTestAgentSessionRecordStore(root!)
  host ??= new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: sessionAdapter,
    journalDatabase: openTestJournalHostDatabase(root!),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  return host
}

async function create(
  transcriptPath: string | undefined,
  sessionAdapter: StructuredAgentSessionAdapter
) {
  const opened = await openHost(sessionAdapter)
  return opened.create({ callerKey: 'client-1' }, attachParams(transcriptPath))
}

describe('adopting a provider conversation on create', () => {
  it('seeds the chain from the adopted handle and fills the journal from its transcript', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-import-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'token ORCA-ADOPT-1')
    const sessionAdapter = adapter()

    const result = await create(transcriptPath, sessionAdapter)

    expect(result).toMatchObject({ ok: true })
    // The seeded chain is what tells the first start which conversation to resume.
    expect(store?.getRecord(SESSION)?.providerHandleChain).toEqual([
      expect.objectContaining({
        origin: 'adopted',
        handle: { provider: 'codex', threadId: THREAD }
      })
    ])
    const page = (result as { value: { page: { items: unknown[] } } }).value.page
    expect(JSON.stringify(page.items)).toContain('ORCA-ADOPT-1')
    expect(sessionAdapter.acquire).not.toHaveBeenCalled()
  })

  it('replays create without replacing journal-only messages or rereading the source', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-replay-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'original turn')
    const sessionAdapter = adapter()
    const first = await create(transcriptPath, sessionAdapter)
    expect(first.ok).toBe(true)
    const journal = host?.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('no open journal')
    }
    await journal.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: THREAD, recordId: 'journal-only' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not yet in rollout' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rm(transcriptPath)
    const replay = await create(transcriptPath, sessionAdapter)
    expect(replay).toMatchObject({ ok: true, replayed: true })
    if (!first.ok || !replay.ok) {
      throw new Error('create failed')
    }
    expect(replay.cursor.epoch).toBe(first.cursor.epoch)
    expect(JSON.stringify(replay.value.page.items)).toContain('not yet in rollout')
    expect(sessionAdapter.acquire).not.toHaveBeenCalled()
  })

  it.each(['missing', 'oversized', 'empty', 'invalid', 'source-less'] as const)(
    'refuses %s source before claiming a conversation',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'orca-adopt-preflight-'))
      const transcriptPath = join(root, 'rollout.jsonl')
      if (kind === 'oversized') {
        await writeCodexRollout(transcriptPath, 'original turn')
        await truncate(transcriptPath, 16 * 1024 * 1024 + 1)
      } else if (kind === 'empty' || kind === 'invalid') {
        await writeFile(transcriptPath, kind === 'empty' ? '' : 'not json\n')
      }
      const sessionAdapter = adapter()
      const result = await create(
        kind === 'source-less' ? undefined : transcriptPath,
        sessionAdapter
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
      expect(store?.getRecord(SESSION)).toBeNull()
      expect(store?.listOperationRows()).toEqual([])
      if (kind === 'oversized') {
        expect(JSON.stringify(result)).toContain('import bound')
      }
    }
  )

  // The import runs after the at-rest record commits. A create cut short there (a throw, a crash, a
  // quit) leaves its operation pending, so its replay imports again rather than answering empty.
  it.each([
    [
      'import write',
      () =>
        vi
          .spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
          .mockRejectedValueOnce(new Error('disk write failed')),
      'disk write failed'
    ],
    [
      'journal open',
      (sessionAdapter: StructuredAgentSessionAdapter) => {
        sessionAdapter.historyFilePath = vi
          .fn<NonNullable<StructuredAgentSessionAdapter['historyFilePath']>>()
          .mockRejectedValueOnce(new Error('journal path unavailable'))
          .mockResolvedValue(null)
      },
      'journal path unavailable'
    ]
  ] as const)(
    'imports the history on the replay of a create whose %s failed',
    async (_case, interrupt, message) => {
      root = await mkdtemp(join(tmpdir(), 'orca-adopt-interrupted-'))
      const transcriptPath = join(root, 'rollout.jsonl')
      await writeCodexRollout(transcriptPath, 'token ORCA-ADOPT-REPLAYED')
      const sessionAdapter = adapter()
      interrupt(sessionAdapter)

      await expect(create(transcriptPath, sessionAdapter)).rejects.toThrow(message)
      expect(store?.getOperationRow('client-1', OPERATION)?.outcome).toEqual({ status: 'pending' })

      const replay = await create(transcriptPath, sessionAdapter)
      expect(replay).toMatchObject({ ok: true, replayed: true })
      if (!replay.ok) {
        throw new Error('create replay failed')
      }
      expect(JSON.stringify(replay.value.page.items)).toContain('ORCA-ADOPT-REPLAYED')
      expect(store?.getOperationRow('client-1', OPERATION)?.outcome).toEqual({
        status: 'succeeded',
        sessionId: SESSION
      })
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
    }
  )

  it('prepares a valid source once before the record claims it and imports those exact items', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-once-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'prepared before claiming')
    const prepare = vi.spyOn(legacyImport, 'prepareLegacyTranscriptImport')
    const sessionAdapter = adapter()
    const opened = await openHost(sessionAdapter)
    const createAtRest = opened.deps.store.createAtRest
    vi.spyOn(opened.deps.store, 'createAtRest').mockImplementation(async (request) => {
      expect(prepare).toHaveBeenCalledTimes(1)
      // Gone once the record claims it: the import must use what was prepared.
      await rm(transcriptPath)
      return createAtRest(request)
    })
    const result = await create(transcriptPath, sessionAdapter)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('create failed')
    }
    expect(JSON.stringify(result.value.page.items)).toContain('prepared before claiming')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(sessionAdapter.acquire).not.toHaveBeenCalled()
  })
})
