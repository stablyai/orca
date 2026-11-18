import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
// Exercise host child-work projections without a renderer. Use literal expectations: comparing with the provider tracker would share the producer's observation bugs.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status/child-work/agent-status-child-work-view'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status/contracts/agent-status-subject'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../../codex/app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from '../../codex/app-server/codex-app-server-connection'
import { collectRuntimeWorktreeAgentSources } from '../workspaces/process-listing/runtime-worktree-agent-sources'
import { AgentHookServer, _internals } from '../../agent-hooks/server/agent-hook-server'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionStatusSink } from '../../native-chat/agent-session-wire/observations/structured-agent-session-status-ownership'
import { stopStructuredAgentSessionRuntime } from './installation/structured-agent-session-runtime'
import { ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost } from './records/agent-session-record-store-test-harness'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { scriptedCodexTransport } from './testing/scripted-codex-transport.test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const THREAD = 'thread-switch'
const REVIEWER = 'thread-reviewer'
const ROUTES: Record<string, unknown> = {
  'thread/start': { thread: { id: THREAD } },
  'turn/start': { turn: { id: 'p2', status: 'inProgress' } },
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

  it('carries running children to both, retains settled agents for inspection, and folds the parent row', async () => {
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
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      // Side reads (at-rest `/` commands) spawn the CLI directly; a missing binary keeps them off the real codex.
      resolveCodexCommand: () => ({ command: join(root, 'codex-not-installed'), prefixArgs: [] }),
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      ...scriptedCodexTransport(openConnection),
      statusSink
    })
    const attachParams = hostTestAttachParams(null, {
      providerHandle: undefined,
      options: { model: 'gpt-test' }
    })
    attachParams.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
    const attached = await host.attach({ callerKey: 'switch-test' }, attachParams)
    expect(attached).toMatchObject({ ok: true })
    const fence = attached.ok ? attached.value.fence : 0
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
    await host.subscribe({
      id: 'strip',
      sessionId: SESSION,
      emit: (event) => {
        if ('backgroundTasks' in event && event.backgroundTasks !== undefined) {
          strip.push(event.backgroundTasks)
        }
      }
    })
    const settle = () => host.flushStreamedEvents(SESSION)
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
    // The summary publishes after its own journal read, independently of the strip and of `settle`.
    const both = async (expected: Row[]) => {
      await vi.waitFor(() => {
        expect(stripRows()).toEqual(expected)
        expect(summaryRows()).toEqual(expected)
      })
      const sources = collectRuntimeWorktreeAgentSources({
        hookSnapshots: server.getStatusSnapshot(),
        readStructuredSummary: host.readStatusSummary,
        mirroredWorktreeIdByTabId: new Map(),
        connectedPtyEvidence: {
          tabIds: new Set(),
          paneKeys: new Set(),
          ptyIdByTerminalHandle: new Map(),
          terminalHandleByPaneKey: new Map()
        }
      })
      expect([...sources.values()].flatMap((source) => rows(source.children))).toEqual(expected)
      expect(stripRows()).toEqual(expected)
    }

    const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('expected the attached journal')
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = journal.readInOrder(() => {
      entered.resolve()
      return release.promise
    })
    await entered.promise
    try {
      connections[0]?.onNotification?.('turn/started', {
        threadId: THREAD,
        turn: { id: 'p1', status: 'inProgress' }
      })
      connections[0]?.onNotification?.('item/completed', {
        threadId: THREAD,
        turnId: 'p1',
        item: { type: 'agentMessage', id: 'lead-1', text: 'Spawning a reviewer' }
      })
      connections[0]?.onNotification?.('turn/started', {
        threadId: REVIEWER,
        turn: { id: 'r1', status: 'inProgress' }
      })
      connections[0]?.onNotification?.('item/started', {
        threadId: THREAD,
        turnId: 'p1',
        item: {
          type: 'subAgentActivity',
          id: 'spawn-1',
          kind: 'started',
          agentThreadId: REVIEWER,
          agentPath: '/root/review'
        }
      })
    } finally {
      release.resolve()
    }
    await held
    await settle()
    await both([{ kind: 'agent', description: 'review', state: 'working', membership: 'live' }])
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
    // Foreground shell records keep status live; surfaces show the child's tool instead.
    await both([
      {
        kind: 'agent',
        description: 'review',
        state: 'working',
        membership: 'live',
        tool: 'Bash: npm run dev'
      }
    ])

    await item('item/completed', REVIEWER, 'r1', {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'npm test',
      source: 'unifiedExecStartup',
      status: 'completed',
      exitCode: 0
    })
    await both([
      {
        kind: 'agent',
        description: 'review',
        state: 'working',
        membership: 'live',
        tool: 'Bash: npm run dev'
      }
    ])

    // The parent's turn ends first: its own work is done, a subagent's is not.
    await notify('turn/completed', { threadId: THREAD, turn: { id: 'p1', status: 'completed' } })
    expect(parentRow()).toMatchObject({ state: 'working' })
    expect(parentRow()).not.toHaveProperty('workingMode')

    // The child finishes; the shell it launched still runs.
    await notify('turn/completed', { threadId: REVIEWER, turn: { id: 'r1', status: 'completed' } })
    await both([
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
    // The finished agent remains inspectable; its stopped command and live sidebar status leave.
    expect(summaries.at(-1)).not.toHaveProperty('children')
    expect(summaries.at(-1)).not.toHaveProperty('backgroundTasks')
    await vi.waitFor(() =>
      expect(stripRows()).toEqual([
        {
          kind: 'agent',
          description: 'review',
          state: 'done',
          membership: 'settled',
          outcome: 'succeeded'
        }
      ])
    )
    expect(strip.at(-1)).toMatchObject({ supportsStopAll: false })
    const stored = () => rows(server.getStructuredChildWorkViews(parentSubject(summaries)))
    expect(stored()).toEqual([
      {
        kind: 'agent',
        description: 'review',
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded'
      }
    ])

    // A turn nobody sent retires nothing: only the user's next message does.
    await notify('turn/started', { threadId: THREAD, turn: { id: 'p-own', status: 'inProgress' } })
    await notify('turn/completed', { threadId: THREAD, turn: { id: 'p-own', status: 'completed' } })
    expect(stored()).toHaveLength(1)
    const body = hostTestMessage('check it again')
    const clientOperationId = `${Date.now()}-${'2'.padStart(32, '0')}`
    await host.send(
      { callerKey: 'switch-test' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: fence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
    await vi.waitFor(async () =>
      expect(
        (
          await host.automationRun(SESSION, clientOperationId, [clientOperationId])
        ).submissions.find((entry) => entry.clientMessageId === clientOperationId)?.handedOverAt
      ).toBeDefined()
    )
    await notify('turn/started', { threadId: THREAD, turn: { id: 'p2', status: 'inProgress' } })
    await notify('item/started', {
      threadId: THREAD,
      turn: { id: 'p2' },
      item: { type: 'userMessage', id: 'user-2', clientId: clientOperationId }
    })
    await vi.waitFor(() => {
      expect(stored()).toEqual([])
      expect(strip.at(-1)).toBeNull()
      expect(summaries.at(-1)).not.toHaveProperty('children')
    })

    // Provider exit ends live status; the agent remains inspectable with an unknown outcome.
    await notify('turn/started', { threadId: REVIEWER, turn: { id: 'r2', status: 'inProgress' } })
    await both([{ kind: 'agent', description: 'review', state: 'working', membership: 'live' }])
    connections[0]?.onExit?.(new Error('scripted provider exit'))
    await settle()
    await vi.waitFor(() => {
      expect(summaries.at(-1)).not.toHaveProperty('children')
      expect(summaries.at(-1)).not.toHaveProperty('backgroundTasks')
      expect(stripRows()).toEqual([
        {
          kind: 'agent',
          description: 'review',
          state: 'done',
          membership: 'settled',
          outcome: 'unknown'
        }
      ])
    })
    expect(strip.at(-1)).toMatchObject({ supportsStopAll: false })
    expect(stored()).toEqual([
      {
        kind: 'agent',
        description: 'review',
        state: 'done',
        membership: 'settled',
        outcome: 'unknown'
      }
    ])

    // Closing its tab lets go of the session: its row, and every child record with it, leave the
    // store.
    const subject = parentSubject(summaries)
    await host.setSessionTabVisibility(SESSION, false)
    await host.close(SESSION, 'user-close')
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
