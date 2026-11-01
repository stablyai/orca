import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import { runClaudeControl } from '../../claude/claude-agent-sdk-control-requests'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../../claude/structured/claude-structured-session-state'
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
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

export const CALLER = { callerKey: 'client-1' }
// Claude Code 2.1.280 system/init capabilities.

export const CAPABILITIES = [
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
  'msg_lifecycle_v1'
]

let root: string

let host: StructuredAgentSessionHost

let adapter: ClaudeStructuredSessionAdapter

let store: AgentSessionRecordStore

let queued: string[]

let claude: ReturnType<typeof fakeClaude>

let events: ClaudeStructuredSessionEvent[]

let logs: ReturnType<typeof recordingStructuredAgentSessionLogger>

let server: AgentHookServer

let statusSubject: AgentStatusStructuredSessionSubject | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-ends-session-'))
  resetHostTestOperationIds()
  queued = []
  events = []
  logs = recordingStructuredAgentSessionLogger()
  server = new AgentHookServer()
  statusSubject = undefined
  claude = fakeClaude({
    replayUuid: null,
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
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      cliFlag: async () => 'supported' as const,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      events.push(event)
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onChildWorkEvidence: (sessionId, evidence) =>
      host.publishChildWorkEvidence(sessionId, evidence),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: logs.logger,
    statusSink: {
      publish: (summary, subject) => {
        statusSubject = subject
        server.ingestStructuredStatus(summary, subject)
      },
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    },
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  await Promise.all(lifecycle)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

export const laneDrained = (): Promise<void> => host['tasks'].serialize(SESSION, async () => {})

export const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

// Exercise the real control deadline with a request that never answers.

export const NEVER_ANSWERS = (options?: Record<string, unknown>) =>
  runClaudeControl(
    'interrupt',
    () => new Promise(() => {}),
    typeof options?.timeoutMs === 'number' ? options.timeoutMs : undefined
  )

export const BRANCH_QUESTION = {
  questions: [
    {
      question: 'Which branch?',
      header: 'Branch',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'dev' }]
    }
  ]
}
export const fixture = {
  get adapter() {
    return adapter
  },
  set adapter(value: typeof adapter) {
    adapter = value
  },
  get claude() {
    return claude
  },
  set claude(value: typeof claude) {
    claude = value
  },
  get events() {
    return events
  },
  set events(value: typeof events) {
    events = value
  },
  get host() {
    return host
  },
  set host(value: typeof host) {
    host = value
  },
  get logs() {
    return logs
  },
  set logs(value: typeof logs) {
    logs = value
  },
  get queued() {
    return queued
  },
  set queued(value: typeof queued) {
    queued = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  },
  get server() {
    return server
  },
  set server(value: typeof server) {
    server = value
  },
  get statusSubject() {
    return statusSubject
  },
  set statusSubject(value: typeof statusSubject) {
    statusSubject = value
  },
  get store() {
    return store
  },
  set store(value: typeof store) {
    store = value
  }
}
