// Interrupted rewinds must launch their saved fork; legacy records without one refuse the rewind and resume by session id.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionRewindFork } from '../../shared/agent-session-rewind'
import { claudeSessionIdForOrcaSession } from '../claude/structured/claude-structured-session-id'
import { fakeClaude } from '../claude/claude-structured-session-test-support'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { createClaudeStructuredLaunchResolver } from './structured-agent-launch-composition.test-support'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

const caller = { callerKey: 'desktop' }
const PROVIDER_SESSION_ID = claudeSessionIdForOrcaSession(HOST_TEST_SESSION)
const TARGET = agentJournalItemKey({
  provider: 'claude',
  sessionId: PROVIDER_SESSION_ID,
  uuid: 'kept'
})
let directory: string
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let adapter: ReturnType<typeof createStructuredClaudeRuntimeAdapter>
let host: StructuredAgentSessionHost
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>

function attachParams(fence: number | null) {
  return hostTestAttachParams(fence, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(directory, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'turn-end' }
  })
}

function rewindParams(fence: number) {
  const fields = { itemId: TARGET, expectedEpoch: 'epoch-before' }
  return {
    ...fields,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields
      })
    }
  }
}

const fence = (): number => store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence

/** What an older build left behind: an admitted rewind whose outcome was never recorded. */
async function seedPendingRewind(
  phase: 'prepared' | 'provider-succeeded',
  providerFork?: AgentSessionRewindFork
) {
  const request = rewindParams(fence())
  // A rewind had a turn to target, so Claude had written the transcript a resume continues.
  const projects = join(directory, 'claude-home', 'projects', 'workspace')
  await mkdir(projects, { recursive: true })
  await writeFile(join(projects, `${PROVIDER_SESSION_ID}.jsonl`), '')
  await store.admitMutationOperation({
    callerKey: caller.callerKey,
    envelope: request.envelope,
    hostFingerprint: request.envelope.payloadFingerprint,
    now: HOST_TEST_NOW
  })
  await store.recordOperationOutcome({
    callerKey: caller.callerKey,
    operationId: request.envelope.clientOperationId,
    outcome: { status: 'unknown' }
  })
  await store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
    ...record,
    rewind: {
      operationId: request.envelope.clientOperationId,
      callerKey: caller.callerKey,
      itemId: TARGET,
      providerItemId: TARGET,
      expectedEpoch: request.expectedEpoch,
      phase,
      ...(providerFork ? { providerFork } : { retained: [] })
    }
  }))
  return request
}

async function reattach() {
  await host.close(HOST_TEST_SESSION, 'evict')
  expect(await host.attach(caller, attachParams(fence()))).toMatchObject({ ok: true })
}

beforeEach(async () => {
  resetHostTestOperationIds()
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-pending-rewind-'))
  store = await openTestAgentSessionRecordStore(directory)
  claude = fakeClaude({ initSessionId: PROVIDER_SESSION_ID })
  adapter = createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveLaunch: createClaudeStructuredLaunchResolver({
      store,
      resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
      resolveLaunchArgs: () => [],
      resolveAuthPolicy: () => ({ account: 'system' })
    }),
    openClaudeConnection: claude.openConnection,
    readProcessStartTime: async () => HOST_TEST_NOW,
    // A rewind runs only once the agent has proven its start, which the host learns from these.
    onLifecycleEvent: (event) => void host.handleAdapterEvent(event)
  })
  log = recordingStructuredAgentSessionLogger()
  // Only Claude sessions are attached here; the router supplies the production create gate.
  const agents = claudeAndCodexAgents({ claude: adapter, codex: adapter })
  host = new StructuredAgentSessionHost({
    agents,
    logger: log.logger,
    store,
    adapter: new StructuredAgentSessionAdapterRouter(agents, () => adapter.closeAll()),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
  expect(await host.attach(caller, attachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await adapter.closeAll()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('a pending Claude rewind', () => {
  it('launches the fork a rewind saved, even when it was cut short before finishing', async () => {
    const fork: AgentSessionRewindFork = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      sourceSessionId: PROVIDER_SESSION_ID,
      throughEntryId: 'answer-1',
      replacesSessionId: PROVIDER_SESSION_ID
    }
    await seedPendingRewind('prepared', fork)
    await host.close(HOST_TEST_SESSION, 'evict')
    await host.attach(caller, attachParams(fence()))
    expect(claude.connections.at(-1)?.launch.options).toMatchObject({
      sessionId: fork.sessionId,
      resume: PROVIDER_SESSION_ID,
      resumeSessionAt: 'answer-1',
      forkSession: true
    })
  })

  it.each(['prepared', 'provider-succeeded'] as const)(
    'settles an older build’s %s rewind as refused and resumes by session id',
    async (phase) => {
      const pending = await seedPendingRewind(phase)
      await reattach()

      expect(claude.connections.at(-1)?.launch.options).toMatchObject({
        resume: PROVIDER_SESSION_ID
      })
      expect(claude.connections.at(-1)?.launch.options).not.toHaveProperty('resumeSessionAt')
      const record: AgentSessionRecord | null = store.getRecord(HOST_TEST_SESSION)
      expect(record?.rewind).toMatchObject({ phase: 'refused', reason: 'unsupported' })
      // The operation resolves too: a retry is refused as unsupported, not as an unknown outcome.
      expect(await host.rewind(caller, pending)).toMatchObject({
        ok: false,
        refusal: { rewindReason: 'unsupported' }
      })
    }
  )

  it('still attaches when settling the pending rewind fails, and logs it', async () => {
    await seedPendingRewind('prepared')
    const transition = store.transitionHandoff.bind(store)
    vi.spyOn(store, 'transitionHandoff').mockImplementation((sessionId, apply) =>
      transition(sessionId, (record) => {
        const next = apply(record)
        if (next.rewind?.phase === 'refused') {
          throw new Error('record write failed')
        }
        return next
      })
    )

    await reattach()

    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('prepared')
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          scope: 'rewind-unsupported-settlement',
          sessionId: HOST_TEST_SESSION,
          error: expect.any(Error)
        })
      })
    )
  })
})
