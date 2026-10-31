// A CLI stuck in initialize receives no sends; acceptance and Stop must remain responsive.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let answerInitialize: () => void = () => {}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-hung-start-stop-'))
  resetHostTestOperationIds()
  claude = fakeClaude({ initProof: 'none', replayUuid: null, holdInit: true })
  const openConnection = claude.openConnection
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: async (...args) => {
      const connection = await openConnection(...args)
      const fake = claude.connections.find((candidate) => candidate === connection)
      answerInitialize = () => fake?.initialization.resolve({ models: [] })
      return connection
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: createStructuredAgentSessionLogger(),
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
})

afterEach(async () => {
  host.stopDelivery()
  claude.dispose()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function readsWorking(): Promise<boolean> {
  const snapshot = await host.journalSnapshot(SESSION)
  return isStructuredAgentSessionMainAgentWorking(
    activeStructuredAgentSessionTurnId(snapshot.items),
    snapshot.submissions,
    store.getRecord(SESSION)!.lease.runtimeFence
  )
}

async function expectHeld(id: string): Promise<void> {
  expect(await submission(id)).toMatchObject({ dispatchState: 'pending' })
  expect((await submission(id))?.handedOverAt).toBeUndefined()
  expect(claude.connections[0]!.sent).toEqual([])
}

it('ends empty initialization without a cancellation request row', async () => {
  expect(host['sessions'].get(SESSION)?.child?.phase).toBe('starting')
  expect(
    await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child).toBeNull())
  expect(
    (await host.journalSnapshot(SESSION)).items.filter((item) => item.body.kind === 'status')
  ).toEqual([])
  expect(claude.connections[0]!.closeCount).toBeGreaterThan(0)
})

it('holds the message from a start that never answers, and a Stop ends it: stopped, nothing working', async () => {
  expect(host['sessions'].get(SESSION)?.child?.phase).toBe('starting')
  const body = hostTestMessage('hello')
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  const id = sent.value.clientMessageId
  const [connection] = claude.connections

  await expectHeld(id)
  expect(connection!.calls).toEqual([{ subtype: 'initialize' }])
  expect(host['sessions'].get(SESSION)?.child?.phase).toBe('starting')
  expect(await readsWorking()).toBe(true)

  const stopped = await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })

  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(
    (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
      item.body.kind === 'status' ? [item.body.text] : []
    )
  ).toEqual(['Cancellation requested.'])
  await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child).toBeNull())
  expect(connection!.closeCount).toBeGreaterThan(0)
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === id
      )
    ).toMatchObject({ dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })
  )
  expect(await readsWorking()).toBe(false)
})

async function sendHello(written: boolean): Promise<string> {
  const body = hostTestMessage('hello')
  const sent = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body,
    userSend: true
  })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  await (written
    ? vi.waitFor(() => expect(claude.connections[0]!.sent).toHaveLength(1))
    : expectHeld(sent.value.clientMessageId))
  return sent.value.clientMessageId
}

async function submission(id: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

it.each(['user-close', 'evict'] as const)(
  'keeps a message held behind a start that never answered as a held card when a %s ends it',
  async (cause) => {
    const id = await sendHello(false)

    await host.close(SESSION, cause)

    await vi.waitFor(async () =>
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        reason: 'The chat closed before this message was sent.',
        keptAsQueuedMessageId: id
      })
    )
  }
)

it('leaves a message in doubt when the start answered and the chat closes before the echo', async () => {
  answerInitialize()
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  const id = await sendHello(true)

  await host.close(SESSION, 'user-close')

  await vi.waitFor(async () =>
    expect(await submission(id)).toMatchObject({ dispatchState: 'unknown' })
  )
})
