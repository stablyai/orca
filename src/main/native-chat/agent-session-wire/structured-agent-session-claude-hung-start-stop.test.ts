// A Claude CLI that never answers initialize is handed nothing: the host accepts the chat's message
// at once and holds it until the start proves itself, and the chat's Stop still ends the start. On
// the shipping adapter and host, against a CLI that echoes nothing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { ClaudeControlRequestTimeoutError } from '../../claude/claude-agent-sdk-control-requests'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
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
/** Answers initialize, which the CLI otherwise never does; it echoes nothing either way. */
let answerInitialize: () => void = () => {}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-hung-start-stop-'))
  resetHostTestOperationIds()
  // Alive, and silent: no initialize answer, no start frame, no echo of what it is sent.
  claude = fakeClaude({ initProof: 'none', replayUuid: null })
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
      const fake = claude.connections.at(-1)
      connection.initializationResult = () => {
        fake?.calls.push({ subtype: 'initialize' })
        return new Promise((resolve) => {
          answerInitialize = () => resolve({ models: [] })
        })
      }
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
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
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

/** The one rule every session list's Working and the chat's own Stop read. */
async function readsWorking(): Promise<boolean> {
  const snapshot = await host.journalSnapshot(SESSION)
  return isStructuredAgentSessionMainAgentWorking(
    activeStructuredAgentSessionTurnId(snapshot.items),
    snapshot.submissions,
    store.getRecord(SESSION)!.lease.runtimeFence
  )
}

async function settledDelivery(): Promise<void> {
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
}

/** Whether the CLI was written `hello`, once the delivery loop has settled what it does with it. */
async function helloWritten(): Promise<boolean> {
  await settledDelivery()
  return claude.connections[0]!.sent.some((message) => JSON.stringify(message).includes('hello'))
}

it('holds the message from a start that never answers, and a Stop ends it: stopped, nothing working', async () => {
  expect(host['sessions'].get(SESSION)?.child?.phase).toBe('starting')
  const body = hostTestMessage('hello')
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  const id = sent.value.clientMessageId
  const [connection] = claude.connections

  // Accepted, and held while initialize is still unanswered.
  expect(await helloWritten()).toBe(false)
  expect(connection!.calls).toEqual([{ subtype: 'initialize' }])
  expect(host['sessions'].get(SESSION)?.child?.phase).toBe('starting')
  expect(await readsWorking()).toBe(true)

  const stopped = await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })

  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child).toBeNull())
  expect(connection!.closeCount).toBeGreaterThan(0)
  // Withdrawn, not in doubt: it was never handed over.
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
  // A person's send, which a close keeps as a held card.
  const sent = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body,
    userSend: true
  })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  await vi.waitFor(async () => expect(await helloWritten()).toBe(written))
  return sent.value.clientMessageId
}

async function submission(id: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

// A CLI that never answered initialize was handed nothing: a close settles the held message as it
// does any queued send, keeping the person's words as a held card.
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

// Once it answered, the CLI may have taken the message without echoing it yet: a close leaves it in
// doubt, as for any running child.
it('leaves a message in doubt when the start answered and the chat closes before the echo', async () => {
  answerInitialize()
  await adapter['sessions'].get(SESSION)?.startup.settled
  const id = await sendHello(true)

  await host.close(SESSION, 'user-close')

  await vi.waitFor(async () =>
    expect(await submission(id)).toMatchObject({ dispatchState: 'unknown' })
  )
})

it.each(['accept-edits', 'auto'] as const)(
  'Stop closes an inherited %s child while initialize is withheld, without sending input',
  async (mode) => {
    const session = adapter['sessions'].get(SESSION)
    if (!session) {
      throw new Error('no starting child')
    }
    session.launchPermissionMode = mode
    const preparing = vi.spyOn(adapter, 'prepareDispatch')
    const body = hostTestMessage('inherited permission')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await settledDelivery()
    // The start barrier holds the send ahead of any permission preparation.
    expect(preparing).not.toHaveBeenCalled()
    const [connection] = claude.connections
    expect(connection!.sent).toEqual([])
    const result = { settled: false }
    const stop = host
      .cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
      .then((outcome) => {
        result.settled = true
        return outcome
      })
    await vi.waitFor(() => expect(result.settled).toBe(true))
    expect(await stop).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(connection!.closeCount).toBeGreaterThan(0)
    expect(connection!.sent).toEqual([])
    expect(host['sessions'].get(SESSION)?.child).toBeNull()
    expect(await readsWorking()).toBe(false)
  }
)

it('close can settle inherited permission preparation without an initialize answer', async () => {
  const session = adapter['sessions'].get(SESSION)
  if (!session) {
    throw new Error('no starting child')
  }
  session.launchPermissionMode = 'accept-edits'
  const preparing = vi.spyOn(adapter, 'prepareDispatch')
  const body = hostTestMessage('close before permissions')
  await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body,
    userSend: true
  })
  await settledDelivery()
  expect(preparing).not.toHaveBeenCalled()
  const closed = { settled: false }
  const close = host.close(SESSION, 'user-close').then(() => {
    closed.settled = true
  })
  await vi.waitFor(() => expect(closed.settled).toBe(true))
  await close
  expect(claude.connections[0]!.sent).toEqual([])
  expect(claude.connections[0]!.closeCount).toBeGreaterThan(0)
})

it('rechecks policy after a lost permission reply between acquisition and handover', async () => {
  answerInitialize()
  const session = adapter['sessions'].get(SESSION)
  if (!session) {
    throw new Error('missing child')
  }
  await session.startup.settled
  session.options.set('permissionMode', 'ask')
  let providerMode: unknown = 'default'
  claude.routes.set_permission_mode = (params) => {
    providerMode = params?.mode
    if (providerMode === 'acceptEdits') {
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
    return {}
  }
  const serialize = host['serialize']
  let inject = true
  host['serialize'] = async (sessionId, task) => {
    const result = await serialize(sessionId, task)
    if (inject && result && typeof result === 'object' && 'awaited' in result) {
      inject = false
      await expect(
        adapter.setOption({
          sessionId: SESSION,
          fence: session.fence,
          key: 'permissionMode',
          value: 'accept-edits'
        })
      ).rejects.toThrow('timed out')
    }
    return result
  }
  const body = hostTestMessage('after uncertain policy')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(() => expect(claude.connections[0].sent).toHaveLength(1))
  expect(providerMode).toBe('default')
  expect(session.appliedPermissionMode).toBe('ask')
  expect(
    claude.connections[0].calls
      .filter((call) => call.subtype === 'set_permission_mode')
      .map((call) => call.params?.mode)
  ).toEqual(['acceptEdits', 'default'])
})
