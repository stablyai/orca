// Source validation must finish before a new session claims the provider conversation.

import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach, type AttachFlowInput } from './structured-agent-session-attach-flow'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import * as legacyImport from '../agent-session-journal/journal-legacy-import'

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
  onAttached: AttachFlowInput['onAttached'] = () => {}
) {
  store ??= await AgentSessionRecordStore.open({ directory: join(root!, 'store'), hostId: 'local' })
  return performAttach({
    store,
    adapter: sessionAdapter,
    journalRoot: root!,
    authority: {
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    params: attachParams(transcriptPath),
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

  it('replays create without replacing journal-only messages or rereading the source', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-replay-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'original turn')
    const sessionAdapter = adapter()
    const first = await attach(transcriptPath, sessionAdapter, async ({ journal }) => {
      await journal.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: THREAD, recordId: 'journal-only' },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not yet in rollout' }] },
        { fence: 1 }
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
        await truncate(transcriptPath, 16 * 1024 * 1024 + 1)
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
        expect(JSON.stringify(result)).toContain('import bound')
      }
    }
  )

  it('still releases acquisition and closes the provisional journal on an import write failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-write-failure-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'valid source')
    vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems').mockRejectedValueOnce(
      new Error('disk write failed')
    )
    const close = vi.spyOn(agentSessionJournalCloseRetries, 'closeOrRetain')
    const sessionAdapter = adapter()
    await expect(attach(transcriptPath, sessionAdapter)).rejects.toThrow('disk write failed')
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(sessionAdapter.releaseAcquisition).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
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
