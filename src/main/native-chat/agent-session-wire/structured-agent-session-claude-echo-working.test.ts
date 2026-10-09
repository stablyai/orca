// Claude's echo of a sent message both answers the send and opens its turn. Whatever order the
// host publishes those in, a chat reading its frames one at a time must read working throughout:
// Stop and every session list's Working come from that one rule. Claude may compact before that
// echo, and the chat's live line says so meanwhile.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { selectStructuredAgentTurnActivity } from '../../../shared/native-chat-turn-activity'
import { runningStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  claudeStartupSettled
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
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
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
const claude = { current: fakeClaude({ replayUuid: null }) }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-echo-working-'))
  resetHostTestOperationIds()
  claude.current = fakeClaude({ replayUuid: null })
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
    openConnection: claude.current.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
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
  await claudeStartupSettled(adapter, SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

async function expectWorkingThroughEcho(backlog: boolean): Promise<void> {
  const submissions = new Map<string, AgentJournalSubmission>()
  const turns = new Map<string, string>()
  const working: boolean[] = []
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  host.subscribe({
    id: 'chat-1',
    sessionId: SESSION,
    emit: (event) => {
      if (event.type !== 'batch') {
        return
      }
      for (const submission of event.batch.submissions) {
        submissions.set(submission.clientMessageId, submission)
      }
      for (const item of event.batch.items) {
        if (item.body.kind === 'turn') {
          turns.set(item.itemId, item.body.state)
        }
      }
      const running = [...turns].find(([, state]) => state === 'running')?.[0] ?? null
      working.push(
        isStructuredAgentSessionMainAgentWorking(running, [...submissions.values()], fence)
      )
    }
  })
  const body = hostTestMessage('hi')
  await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  await settled()
  const connection = claude.current.connections[0]!
  if (backlog) {
    // The previous cycle's result in the same read, its write issued just ahead of the echo's.
    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-0',
      session_id: PROVIDER_SESSION_ID,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      is_error: false,
      result: ''
    })
  }
  // Claude echoes the written message back, which is what opens its turn.
  connection.handlers.onMessage?.({ ...connection.sent.at(-1)!, uuid: 'echo-uuid' })
  await settled()

  expect([...submissions.values()].map((submission) => submission.dispatchState)).toEqual([
    'accepted'
  ])
  expect([...turns.values()]).toEqual(['running'])
  expect(working).not.toContain(false)
}

it('reads working at every published frame from the send through the echo that opens its turn', () =>
  expectWorkingThroughEcho(false))

it('keeps the settlement behind the turn its echo opens when the previous result arrives in the same read', () =>
  expectWorkingThroughEcho(true))

/** What a chat subscribed to the session reads: its running turn, Working, and the live line. */
function liveLine(events: readonly AgentSessionSubscribeEvent[]) {
  const state = events.reduce(
    (current, event, index) =>
      reduceStructuredAgentSession(current, {
        type: 'event',
        event,
        opensSubscription: index === 0
      }),
    EMPTY_STRUCTURED_AGENT_SESSION
  )
  const turnId = runningStructuredAgentSessionTurnId(state)
  return {
    turnId,
    working: isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence),
    activity: selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null
  }
}

it('reads compacting while Claude compacts ahead of the echo that opens the turn', async () => {
  const events: AgentSessionSubscribeEvent[] = []
  await host.subscribe({ id: 'chat-1', sessionId: SESSION, emit: (event) => events.push(event) })
  const body = hostTestMessage('hi')
  await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  await settled()
  const connection = claude.current.connections[0]!
  const sent = connection.sent.at(-1)!
  const sentUuid = String(sent.uuid)
  const frame = (fields: Record<string, unknown>) =>
    connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...fields })

  frame({ type: 'command_lifecycle', command_uuid: sentUuid, state: 'started', uuid: 'lc-1' })
  frame({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'status-1' })
  await settled()
  expect(liveLine(events)).toEqual({
    turnId: null,
    working: true,
    activity: 'Compacting the conversation'
  })

  frame({ type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: 's-2' })
  await settled()
  expect(liveLine(events)).toEqual({ turnId: null, working: true, activity: null })

  connection.handlers.onMessage?.({ ...sent, isReplay: true })
  await settled()
  expect(liveLine(events)).toEqual({ turnId: sentUuid, working: true, activity: null })
})
