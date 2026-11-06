import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

vi.mock(
  '../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async (importOriginal) => {
    const query = await import('../transcript-opencode-sqlite-query')
    return {
      ...(await importOriginal<object>()),
      readOpenCodeTranscriptPageViaWorker: async (
        args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
      ) => query.readOpenCodeTranscriptPage(args),
      readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
        query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
    }
  }
)

const NOW = 1_800_000_000_000
const SESSION = 'codex_adopting_session'
const THREAD = 'adopted-thread'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null
let store: AgentSessionRecordStore | null = null

afterEach(async () => {
  if (root) {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  }
  root = null
  store = null
  vi.restoreAllMocks()
})

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
      source: {
        providerSessionId: THREAD,
        workspaceCwd: '/workspace',
        conversationStore: root ?? undefined
      },
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
    // Proven release preserves the original failure instead of wrapping unproven exit.
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

describe('adopting a provider conversation on create', () => {
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
    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    await host.flushAllStreamedEvents()
  })
})
