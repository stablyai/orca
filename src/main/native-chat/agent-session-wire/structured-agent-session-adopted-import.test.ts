import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Source validation must finish before a new session claims the provider conversation.

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { performAttach, type AttachFlowInput } from './structured-agent-session-attach-flow'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import * as legacyImport from '../agent-session-journal/journal-legacy-import'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  NO_STRUCTURED_AGENTS,
  structuredAgentsDeclaringNothing
} from './structured-agent-session-adapter-router-test-support'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { writeOpenCodeSqliteDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-fixture'

// The OpenCode reader's worker, run in process.
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (importOriginal) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await importOriginal<object>()),
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})

const NOW = 1_800_000_000_000
const SESSION = 'codex_adopting_session'
const THREAD = 'adopted-thread'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null
let store: AgentSessionRecordStore | null = null

afterEach(async () => {
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

function attachParams(
  transcriptPath?: string,
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams {
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
      providerHandle: codexProviderHandle(THREAD),
      ...(transcriptPath ? { transcriptPath } : {})
    },
    ...overrides
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
    open: async () => ({
      reportedOptions: { model: '' }
    }),
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        acquisitionGeneration: globalThis.crypto.randomUUID(),
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'resumed-link',
          handle: codexProviderHandle(THREAD),
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
    // Proven released, so the failure rethrows its own cause rather than an unproven-exit wrapper.
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

async function attach(
  transcriptPath: string | undefined,
  sessionAdapter: StructuredAgentSessionAdapter,
  onAttached: AttachFlowInput['onAttached'] = () => {},
  params: AgentSessionAttachParams = attachParams(transcriptPath),
  agents = NO_STRUCTURED_AGENTS
) {
  store ??= await openTestAgentSessionRecordStore(root!)
  return performAttach({
    agents,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: sessionAdapter,
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(root!)),
    authority: {
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    params,
    now: () => NOW,
    onAttached
  })
}

describe('adopting a provider conversation on create', () => {
  it('seeds the chain from the adopted handle and fills the journal from its transcript', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-import-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'token ORCA-ADOPT-1')
    const sessionAdapter = adapter()

    const result = await attach(transcriptPath, sessionAdapter)

    expect(result).toMatchObject({ ok: true })
    // The adapter was asked to resume, not to start: the seeded chain is what tells it which
    // conversation this session owns.
    const page = (result as { value: { page: { items: unknown[] } } }).value.page
    expect(JSON.stringify(page.items)).toContain('ORCA-ADOPT-1')
  })

  it.each([
    {
      agent: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/home/dev/.grok' },
      record: async (dir: string, text: string) => {
        const path = join(dir, 'chat_history.jsonl')
        await writeFile(
          path,
          `${JSON.stringify({ type: 'user', content: [{ type: 'text', text }] })}\n`
        )
        return path
      }
    },
    {
      agent: 'opencode',
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
      record: async (dir: string, text: string) => {
        const path = join(dir, 'opencode.db')
        writeOpenCodeSqliteDatabase(path, [
          { id: THREAD, turns: [{ role: 'user', parts: [text] }] }
        ])
        return path
      }
    },
    {
      agent: 'pi',
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/dev/.pi/agent' },
      record: async (dir: string, text: string) => {
        const path = join(dir, `2026-10-12T00-00-00-000Z_${THREAD}.jsonl`)
        const records = [
          { type: 'session', version: 3, id: THREAD, cwd: '/workspace' },
          { type: 'message', id: 'rec-1', parentId: null, message: { role: 'user', content: text } }
        ]
        await writeFile(path, `${records.map((line) => JSON.stringify(line)).join('\n')}\n`)
        return path
      }
    }
  ] as const)(
    "seeds a $agent chat's chain with the session it adopts and imports that CLI's history",
    async ({ agent, accountHome, record }) => {
      root = await mkdtemp(join(tmpdir(), `orca-adopt-${agent}-`))
      const transcriptPath = await record(root, `ORCA-${agent}-ADOPT`)
      const definition = structuredAgentRuntimeRegistration(agent)?.definition
      if (!definition) {
        throw new Error(`this build registers no ${agent} chats`)
      }
      // A Pi chat's handle names its session file; the others name the conversation id.
      const handle = {
        transport: definition.handleTransport,
        agent,
        nativeId: agent === 'pi' ? transcriptPath : THREAD
      }
      const sessionAdapter = adapter()
      vi.mocked(sessionAdapter.acquire).mockImplementation(async ({ fence, spawnToken }) => ({
        acquisitionGeneration: `generation-${fence}`,
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'resumed-link',
          handle,
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }))

      const result = await attach(
        transcriptPath,
        sessionAdapter,
        () => {},
        attachParams(transcriptPath, {
          provider: agent,
          agent,
          accountHome,
          adopt: { providerHandle: handle, transcriptPath }
        }),
        structuredAgentsDeclaringNothing([definition])
      )

      expect(result.ok && JSON.stringify(result.value.page.items)).toContain(`ORCA-${agent}-ADOPT`)
      expect(store?.getRecord(SESSION)?.providerHandleChain[0]).toMatchObject({
        origin: 'adopted',
        handle
      })
    }
  )

  it('replays create without replacing journal-only messages or rereading the source', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-replay-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'original turn')
    const sessionAdapter = adapter()
    const first = await attach(transcriptPath, sessionAdapter, async ({ journal }) => {
      await journal.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: THREAD, recordId: 'journal-only' },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not yet in rollout' }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
    })
    expect(first.ok).toBe(true)
    await rm(transcriptPath)
    const replay = await attach(transcriptPath, sessionAdapter, async ({ journal }) =>
      journal.close()
    )
    expect(replay).toMatchObject({ ok: true, replayed: true })
    if (!first.ok || !replay.ok) {
      throw new Error('attach failed')
    }
    expect(replay.cursor.epoch).toBe(first.cursor.epoch)
    expect(JSON.stringify(replay.value.page.items)).toContain('not yet in rollout')
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'oversized', 'empty', 'invalid', 'source-less'] as const)(
    'refuses %s source before claiming a conversation',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'orca-adopt-preflight-'))
      const transcriptPath = join(root, 'rollout.jsonl')
      if (kind === 'oversized') {
        await writeCodexRollout(transcriptPath, 'original turn')
        await appendFile(transcriptPath, 'x'.repeat(16 * 1024 * 1024 + 1))
      } else if (kind === 'empty' || kind === 'invalid') {
        await writeFile(transcriptPath, kind === 'empty' ? '' : 'not json\n')
      }
      const sessionAdapter = adapter()
      const onAttached = vi.fn()
      const result = await attach(
        kind === 'source-less' ? undefined : transcriptPath,
        sessionAdapter,
        onAttached
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
      expect(sessionAdapter.releaseAcquisition).not.toHaveBeenCalled()
      expect(onAttached).not.toHaveBeenCalled()
      expect(store?.getRecord(SESSION)).toBeNull()
      expect(store?.listOperationRows()).toEqual([])
      if (kind === 'oversized') {
        expect(JSON.stringify(result)).toContain('byte limit')
      }
    }
  )

  it('still releases acquisition on an import write failure, and leaves the conversation open', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-write-failure-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'valid source')
    vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems').mockRejectedValueOnce(
      new Error('disk write failed')
    )
    const sessionAdapter = adapter()
    await expect(attach(transcriptPath, sessionAdapter)).rejects.toThrow('disk write failed')
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(sessionAdapter.releaseAcquisition).toHaveBeenCalledTimes(1)
  })

  it('leaves the conversation writable when the import fails after acquiring', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-host-failure-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'valid source')
    store = await openTestAgentSessionRecordStore(root)
    const host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems').mockRejectedValueOnce(
      new Error('disk write failed')
    )
    const attached = await host
      .attach({ callerKey: 'client-1' }, attachParams(transcriptPath))
      .catch(() => null)
    expect(attached?.ok).not.toBe(true)

    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    const sent = await host.send(
      { callerKey: 'client-1' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${NOW}-${'2'.padStart(32, '0')}`,
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
    // The failed attach kept the conversation's own journal open, so the send is recorded.
    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    await host.flushAllStreamedEvents()
  })

  it('prepares a valid source once before acquisition and imports those exact items', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-once-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'prepared before acquiring')
    const prepare = vi.spyOn(legacyImport, 'prepareLegacyTranscriptImport')
    const sessionAdapter = adapter()
    const acquire = sessionAdapter.acquire
    sessionAdapter.acquire = vi.fn(async (input) => {
      expect(prepare).toHaveBeenCalledTimes(1)
      await rm(transcriptPath)
      return acquire(input)
    })
    const result = await attach(transcriptPath, sessionAdapter, async ({ journal }) =>
      journal.close()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('attach failed')
    }
    expect(JSON.stringify(result.value.page.items)).toContain('prepared before acquiring')
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
