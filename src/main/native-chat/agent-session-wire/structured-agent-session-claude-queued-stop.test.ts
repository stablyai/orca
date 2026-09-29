// A follow-up Claude queued behind the running turn is dropped by Stop, so the chat must record it
// as withdrawn and stop reading as working — under the SessionStart hook Orca installs, whose frame
// proves the start before the turn's system/init says the CLI can cancel its queue.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let queued: string[]
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-queued-stop-'))
  resetHostTestOperationIds()
  queued = []
  claude = fakeClaude({
    replayUuid: null,
    initProof: 'session-start',
    // What the real CLI answers: cancel_queued cancels the queue, a plain interrupt keeps it.
    routes: {
      interrupt: (params) =>
        params?.cancelQueued
          ? { still_queued: [], cancelled: queued.splice(0) }
          : { still_queued: [...queued] }
    }
  })
  const lifecycle: Promise<void>[] = []
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
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    // As the runtime wires it.
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Record<string, unknown>
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

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

async function dispatch(clientMessageId: string) {
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  return { state: submission?.dispatchState, reason: submission?.reason }
}

async function status(): Promise<string> {
  const snapshot = await host.journalSnapshot(SESSION)
  return projectStructuredAgentSessionStatus(
    snapshot.items,
    snapshot.submissions,
    store.getRecord(SESSION)!.lease.runtimeFence
  )
}

it('withdraws a follow-up Claude queued behind the running turn when that turn is stopped', async () => {
  const connection = claude.connections[0]!
  const first = await send('Write a long reply.')
  await eventually(() => expect(connection.sent).toHaveLength(1))
  // Claude opens the turn: its system/init, then the echo of the message it runs.
  connection.handlers.onMessage?.({
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  connection.handlers.onMessage?.({
    ...connection.sent.at(-1)!,
    uuid: connection.sent.at(-1)!.uuid
  })
  await eventually(async () => expect((await dispatch(first)).state).toBe('accepted'))
  const turnId = activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  expect(turnId).not.toBeNull()

  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent).toHaveLength(2))
  queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))

  const stopped = await host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', { turnId }),
    turnId: turnId!
  })
  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  // The interrupted turn closes as the CLI ends it.
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'interrupted-result'
  })
  await eventually(async () =>
    expect(await dispatch(followUp)).toEqual({
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  )
  await eventually(async () => expect(await status()).toBe('idle'))
}, 15_000)
