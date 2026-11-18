import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import {
  attachFingerprintFields,
  reserveRequestFor,
  type AgentSessionAttachParams
} from '../../acquisition/structured-agent-session-attach'
import { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { performAttach } from '../../acquisition/structured-agent-session-attach-flow'
import type { StructuredAgentSessionAttachLock } from '../../acquisition/structured-agent-session-attach-lock'
import { TRAEX_STRUCTURED_AGENT } from '../../../../traex/traex-agent-definition'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'

vi.mock(
  '../../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async (importOriginal) => {
    const query =
      await import('../../../transcript-history/opencode/transcript-opencode-sqlite-query')
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
      journalDatabase: await openTestAgentSessionDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    const write = AgentSessionJournal.prototype.write
    vi.spyOn(AgentSessionJournal.prototype, 'write').mockImplementationOnce(function (
      this: AgentSessionJournal,
      operation,
      prepare
    ) {
      if (operation.kind === 'epoch-replace') {
        throw new Error('disk write failed')
      }
      return write.call(this, operation, prepare)
    })
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

it.each(['cancelled', 'completed'] as const)(
  'prepares %s native history outside the attach commit',
  async (outcome) => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-native-cancel-'))
    const transcriptPath = join(root, 'native-history.jsonl')
    await writeFile(transcriptPath, '{}\n')
    const params = attachParams(transcriptPath, {
      provider: 'trae',
      agent: 'trae',
      accountHome: { variable: 'TRAECLI_HOME', path: root },
      envelope: {
        sessionId: SESSION,
        clientOperationId: OPERATION,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      adopt: {
        transcriptPath,
        providerHandle: { transport: 'traex-app-server', agent: 'trae', nativeId: THREAD }
      }
    })
    store = await openTestAgentSessionRecordStore(root)
    const authority = {
      spawnToken: 'spawn-owner',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' as const }
    }
    const reserved = await store.reserveOwner(
      reserveRequestFor({
        sessionId: SESSION,
        params,
        authority,
        callerKey: 'client-1',
        fingerprint: params.envelope.payloadFingerprint,
        now: NOW
      })
    )
    const fence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-owner' },
      now: NOW
    })
    await store.proveOwner({ sessionId: SESSION, fence, now: NOW })
    const journal = await AgentSessionJournal.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'trae',
        providerHandle: params.adopt!.providerHandle
      },
      database: await openTestAgentSessionDatabase(root)
    })
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const history =
      Promise.withResolvers<
        Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['readConversationHistory']>>>
      >()
    let inCommit = false
    const lock: StructuredAgentSessionAttachLock = {
      signal: controller.signal,
      wait: (work) => work,
      commit: async (step) => {
        controller.signal.throwIfAborted()
        inCommit = true
        try {
          return await step()
        } finally {
          inCommit = false
        }
      }
    }
    try {
      const attaching = performAttach({
        store,
        adapter: {
          ...adapter(),
          supportsLocation: () => true,
          readConversationHistory: async ({ signal }) => {
            entered.resolve()
            if (inCommit) {
              throw new Error('Provider history read held the attach commit')
            }
            if (signal !== controller.signal) {
              throw new Error('Provider history read did not receive attach cancellation')
            }
            signal.addEventListener('abort', () => history.reject(signal.reason), { once: true })
            return history.promise
          }
        },
        agents: { definition: () => TRAEX_STRUCTURED_AGENT },
        logger: createStructuredAgentSessionLogger(),
        authority,
        callerKey: 'client-1',
        params,
        now: () => NOW,
        lock,
        openConversation: async () => journal,
        onAttached: () => {}
      })
      const settled = attaching.then(
        (value) => value,
        (error: unknown) => error
      )
      await Promise.race([
        entered.promise,
        settled.then((outcome) => {
          throw outcome instanceof Error
            ? outcome
            : new Error(
                `Attach ended before native history preparation: ${JSON.stringify(outcome)}`
              )
        })
      ])
      if (outcome === 'cancelled') {
        controller.abort(new Error('Caller cancelled history preparation'))
        await expect(attaching).rejects.toThrow('Caller cancelled history preparation')
      } else {
        history.resolve({
          sourceEmpty: false,
          items: [
            {
              identity: {
                provider: 'legacy',
                agent: 'trae',
                sessionId: SESSION,
                recordId: 'restored-user'
              },
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'Restored conversation' }]
              },
              ownerFence: 0
            }
          ]
        })
        expect(await attaching).toMatchObject({ ok: true })
        expect(
          (await readTestJournalItems(journal)).find((row) => row.body.kind === 'message')?.body
        ).toMatchObject({
          role: 'user',
          blocks: [{ type: 'text', text: 'Restored conversation' }]
        })
      }
    } finally {
      await journal.close()
    }
  }
)
