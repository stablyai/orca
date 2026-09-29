// Claude's echo of a sent message both answers the send and opens its turn. Whatever order the
// host publishes those in, a chat reading its frames one at a time must read working throughout:
// Stop and every session list's Working come from that one rule.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
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

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

it('reads working at every published frame from the send through the echo that opens its turn', async () => {
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
  // Claude echoes the written message back, which is what opens its turn.
  connection.handlers.onMessage?.({ ...connection.sent.at(-1)!, uuid: 'echo-uuid' })
  await settled()

  expect([...submissions.values()].map((submission) => submission.dispatchState)).toEqual([
    'accepted'
  ])
  expect([...turns.values()]).toEqual(['running'])
  expect(working).not.toContain(false)
})
