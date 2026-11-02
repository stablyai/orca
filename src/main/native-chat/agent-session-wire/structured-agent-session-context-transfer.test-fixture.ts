import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { readyConstruction } from './structured-agent-session-construction'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

export const TRANSFER_CALLER = { callerKey: 'client-1' }
export const transferEventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

export async function contextTransferFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-context-transfer-'))
  resetHostTestOperationIds()
  let store = await openTestAgentSessionRecordStore(root)
  let host: StructuredAgentSessionHost
  const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) =>
    readyConstruction({
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      link: {
        linkId: `link-${fence}`,
        handle: codexProviderHandle(THREAD),
        origin: store.requireWritableRecord(SESSION).providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    })
  )
  const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>(async () => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: 0
    }
  }))
  let adapter: StructuredAgentSessionAdapter
  const start = () => {
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: (adapter ??= {
        acquire,
        dispatch,
        open: async () => ({ reportedOptions: { model: '' } }),
        closeSession: vi.fn(async () => true),
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: vi.fn(async () => ({ cancelled: false })),
        answerPrompt: vi.fn(async () => undefined),
        setOption: vi.fn(async () => undefined)
      }),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
      now: () => NOW
    })
  }
  start()
  expect(await host!.attach(TRANSFER_CALLER, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
  const childPhase = () => host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase
  const submission = async (id: string) =>
    (await host.journalSnapshot(SESSION)).submissions.find((row) => row.clientMessageId === id)
  const accept = async (text: string) => {
    const body = hostTestMessage(text)
    const clientOperationId = hostTestOperationId()
    expect(
      await host.send(TRANSFER_CALLER, {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: store.requireWritableRecord(SESSION).lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      })
    ).toMatchObject({ ok: true })
    return clientOperationId
  }
  async function recoverSavedChat(
    inject: NonNullable<StructuredAgentSessionAdapter['injectHistoricalContext']>
  ) {
    const old = await accept('Remember the number 42')
    await transferEventually(async () =>
      expect((await submission(old))?.dispatchState).toBe('accepted')
    )
    acquire.mock.calls
      .at(-1)?.[0]
      .events?.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'remember', ordinal: 1 },
        { ...hostTestMessage('The saved answer is 42'), role: 'assistant' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await host.flushStreamedEvents(SESSION)
    await host.close(SESSION, 'evict')
    let nativeId = THREAD,
      serial = 0,
      missing = true
    const link = (input: { fence: number }, origin: 'created' | 'resumed') => ({
      linkId: `recovery-${input.fence}-${serial}-${origin}`,
      handle: codexProviderHandle(nativeId),
      origin,
      mintedAtFence: input.fence,
      observedAt: NOW
    })
    acquire.mockImplementation(async (input) =>
      readyConstruction({
        acquisitionGeneration: `recovery-generation-${acquire.mock.calls.length}`,
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: NOW,
          spawnToken: input.spawnToken
        }
      })
    )
    host.deps.adapter.injectHistoricalContext = inject
    host.deps.adapter.open = async (input) => {
      const fresh = async () => {
        nativeId = `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`
        missing = false
        return {
          reportedOptions: { model: '' },
          link: link(input, 'created'),
          newConversation: true
        }
      }
      if (
        input.constructionIntent ||
        !store.requireWritableRecord(SESSION).providerHandleChain.length
      ) {
        return readyConstruction(await fresh())
      }
      if (missing) {
        return {
          kind: 'history-unavailable',
          sourceLink: agentSessionProviderHandleChainHead(
            store.requireWritableRecord(SESSION).providerHandleChain
          )!,
          trigger: 'codex-no-rollout',
          createFresh: fresh
        }
      }
      return readyConstruction({ reportedOptions: { model: '' }, link: link(input, 'resumed') })
    }
    dispatch.mockImplementation(async (input) => ({
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: nativeId,
        turnId: input.clientMessageId,
        ordinal: 0
      }
    }))
    expect(
      await host.attach(
        TRANSFER_CALLER,
        hostTestAttachParams(store.requireWritableRecord(SESSION).lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    await transferEventually(() => expect(childPhase()).toBe('ready'))
    return {
      journal: host.collaboratorsForTests().sessions.get(SESSION)!.journal,
      old,
      native: () => nativeId,
      lose: () => {
        missing = true
      }
    }
  }
  return {
    get host() {
      return host
    },
    get store() {
      return store
    },
    root,
    acquire,
    dispatch,
    accept,
    submission,
    childPhase,
    recoverSavedChat,
    async restart() {
      await host.flushAllStreamedEvents()
      await closeTestJournalHostDatabases()
      store = await openTestAgentSessionRecordStore(root)
      start()
    },
    async dispose() {
      await host.flushAllStreamedEvents()
      await closeTestJournalHostDatabases()
      await rm(root, { recursive: true, force: true })
    }
  }
}
