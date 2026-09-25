// The switch, end to end on a host with no renderer: a Codex session's frames reach the host's
// canonical store, and the status summary every session list reads and the chat strip's channel
// both carry the same child records from it, while the parent row is folded from them too.
//
// Deliberately NOT a comparison against the provider tracker's task list: that tracker and the
// record producer read the same child executions, so agreeing with it could not catch a defect in
// what those executions observe. Every expectation below is written out literally.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionStatusSummary
} from '../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const THREAD = 'thread-switch'
const REVIEWER = 'thread-reviewer'
const ROUTES: Record<string, unknown> = {
  'thread/start': { thread: { id: THREAD } },
  'model/list': {
    data: [
      {
        model: 'gpt-test',
        displayName: 'GPT Test',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        isDefault: true
      }
    ],
    nextCursor: null
  }
}

type Row = Pick<AgentChildWorkView, 'kind' | 'description' | 'state' | 'membership'> & {
  outcome?: AgentChildWorkView['outcome']
  tool?: string
  owner?: string
}

/** What a surface would show of each child, independent of which channel carried it. */
function rows(views: readonly AgentChildWorkView[] | undefined): Row[] {
  const byId = new Map((views ?? []).map((view) => [view.id, view]))
  return (views ?? []).map((view) => ({
    kind: view.kind,
    ...(view.description ? { description: view.description } : {}),
    state: view.state,
    membership: view.membership,
    ...(view.outcome ? { outcome: view.outcome } : {}),
    ...(view.operation ? { tool: `${view.operation.toolName}: ${view.operation.input}` } : {}),
    ...(view.parentChildWorkId
      ? { owner: byId.get(view.parentChildWorkId)?.description ?? '?' }
      : {})
  }))
}

describe('the chat strip and the session list read the same host child records', () => {
  let root: string
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    root = await mkdtemp(join(tmpdir(), 'orca-child-records-switch-'))
    server = new AgentHookServer()
  })

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    await rm(root, { recursive: true, force: true })
  })

  it('carries one record per child to both, and folds the parent row from them', async () => {
    const connections: CodexAppServerConnectionHandlers[] = []
    const openConnection: typeof openCodexAppServerConnection = async (_launch, handlers = {}) => {
      connections.push(handlers)
      const connection: CodexAppServerConnection = {
        pid: 4321,
        closed: false,
        request: async (method) => (method in ROUTES ? ROUTES[method] : {}),
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => true
      }
      return connection
    }
    // Production's sink wiring, onto a real hook server: no renderer is involved anywhere.
    const statusSink: StructuredAgentSessionStatusSink = {
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    }
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      statusSink
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
    expect(await host.attach({ callerKey: 'switch-test' }, attachParams)).toMatchObject({
      ok: true
    })
    await host.hold(SESSION, 'desktop-chat:1')
    const summaries: AgentSessionStatusSummary[] = []
    host.subscribeStatus({
      id: 'session-list',
      emit: (event) => {
        if (event.type === 'status') {
          summaries.push(event.session)
        } else if (event.type === 'snapshot') {
          summaries.push(...event.sessions.filter((session) => session.sessionId === SESSION))
        }
      }
    })
    const strip: (AgentSessionBackgroundTaskState | null)[] = []
    host.subscribe({
      id: 'strip',
      sessionId: SESSION,
      emit: (event) => {
        if ('backgroundTasks' in event && event.backgroundTasks !== undefined) {
          strip.push(event.backgroundTasks)
        }
      }
    })
    // Journal writes land asynchronously; let each frame's rows publish before the next.
    const settle = async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    const notify = async (method: string, params: Record<string, unknown>) => {
      connections[0]?.onNotification?.(method, params)
      await settle()
    }
    const item = (
      method: 'item/started' | 'item/completed',
      threadId: string,
      turnId: string,
      value: Record<string, unknown>
    ) => notify(method, { threadId, turnId, item: value })
    const parentRow = () => server.getStatusSnapshot().find((row) => row.structuredHost)
    const summaryRows = () => rows(summaries.at(-1)?.children)
    const stripRows = () => rows(strip.at(-1)?.children ?? undefined)
    const both = (expected: Row[]) => {
      expect(summaryRows()).toEqual(expected)
      expect(stripRows()).toEqual(expected)
    }

    await notify('turn/started', { threadId: THREAD, turn: { id: 'p1', status: 'inProgress' } })
    await item('item/completed', THREAD, 'p1', {
      type: 'agentMessage',
      id: 'lead-1',
      text: 'Spawning a reviewer'
    })
    await notify('turn/started', { threadId: REVIEWER, turn: { id: 'r1', status: 'inProgress' } })
    await item('item/started', THREAD, 'p1', {
      type: 'subAgentActivity',
      id: 'spawn-1',
      kind: 'started',
      agentThreadId: REVIEWER,
      agentPath: '/root/review'
    })
    both([{ kind: 'agent', description: 'review', state: 'working', membership: 'live' }])

    await item('item/started', REVIEWER, 'r1', {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'npm test',
      source: 'agent',
      status: 'inProgress'
    })
    await item('item/started', REVIEWER, 'r1', {
      type: 'commandExecution',
      id: 'exec-1',
      command: 'npm run dev',
      source: 'unifiedExecStartup',
      status: 'inProgress'
    })
    both([
      {
        kind: 'agent',
        description: 'review',
        state: 'working',
        membership: 'live',
        tool: 'Bash: npm test'
      },
      {
        kind: 'command',
        description: 'npm run dev',
        state: 'working',
        membership: 'live',
        owner: 'review'
      }
    ])

    // The parent's turn ends first: its own work is done, a subagent's is not.
    await notify('turn/completed', { threadId: THREAD, turn: { id: 'p1', status: 'completed' } })
    expect(parentRow()).toMatchObject({ state: 'working' })
    expect(parentRow()).not.toHaveProperty('workingMode')

    // The child finishes; the shell it launched still runs.
    await notify('turn/completed', { threadId: REVIEWER, turn: { id: 'r1', status: 'completed' } })
    both([
      {
        kind: 'agent',
        description: 'review',
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded'
      },
      {
        kind: 'command',
        description: 'npm run dev',
        state: 'working',
        membership: 'live',
        owner: 'review'
      }
    ])
    expect(parentRow()).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    // An older client folds the summary's task list: only live work is on it.
    expect(summaries.at(-1)?.backgroundTasks?.map((task) => task.kind)).toEqual(['command'])

    await item('item/completed', REVIEWER, 'r1', {
      type: 'commandExecution',
      id: 'exec-1',
      command: 'npm run dev',
      source: 'unifiedExecStartup',
      status: 'completed',
      exitCode: 0
    })
    expect(parentRow()).toMatchObject({ state: 'done' })
    // Finished children stay listed, with how they ended, until the session's next turn.
    both([
      {
        kind: 'agent',
        description: 'review',
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded'
      },
      {
        kind: 'command',
        description: 'npm run dev',
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded',
        owner: 'review'
      }
    ])

    await notify('turn/started', { threadId: THREAD, turn: { id: 'p2', status: 'inProgress' } })
    expect(summaries.at(-1)).not.toHaveProperty('children')
    expect(strip.at(-1)).toBeNull()

    // The reviewer's next run is still going when the provider exits: it settles with an outcome
    // nobody reported, and both keep listing it.
    await notify('turn/started', { threadId: REVIEWER, turn: { id: 'r2', status: 'inProgress' } })
    both([{ kind: 'agent', description: 'review', state: 'working', membership: 'live' }])
    connections[0]?.onExit?.(new Error('scripted provider exit'))
    await settle()
    both([
      {
        kind: 'agent',
        description: 'review',
        state: 'done',
        membership: 'settled',
        outcome: 'unknown'
      }
    ])

    // Letting go of the session drops its row, and every child record with it, from both.
    const subject = parentSubject(summaries)
    await host.close(SESSION)
    expect(server.getStructuredChildWorkViews(subject)).toEqual([])
    expect(summaries.at(-1)).not.toHaveProperty('children')
    expect(summaries.at(-1)).not.toHaveProperty('backgroundTasks')
  })
})

function parentSubject(summaries: AgentSessionStatusSummary[]) {
  const summary = summaries.at(-1)
  if (!summary) {
    throw new Error('no summary')
  }
  return makeStructuredAgentStatusSubject(
    {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: summary.workspaceId,
      workspaceKind: 'git-worktree'
    },
    summary.sessionId
  )
}
