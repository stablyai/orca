// The production runtime hands a Codex session's child work to the status sink, under the address
// the session's own row landed under, and ends it with the provider.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex/app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'
import { AgentHookServer } from '../agent-hooks/server'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import {
  openStructuredCodexRpcHarness,
  THREAD as RESTART_THREAD,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

const THREAD = 'thread-runtime-child-work'
const CHILD = 'thread-runtime-reviewer'
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

describe('structured Codex child work through the production runtime', () => {
  let root: string | null = null

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = null
    }
  })

  it("hands its subagents to the status sink under the session's own address", async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-codex-child-work-'))
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
    const childWork: Parameters<
      NonNullable<StructuredAgentSessionStatusSink['publishChildWork']>
    >[] = []
    const host = await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      ...scriptedCodexTransport(openConnection),
      statusSink: {
        publish: () => {},
        forget: () => {},
        publishChildWork: (...args) => {
          childWork.push(args)
        }
      }
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    expect(attached).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    // Creating the session starts its child; nothing else has to keep it running.
    expect(connections).toHaveLength(1)
    const notify = (method: string, params: Record<string, unknown>) =>
      connections[0]?.onNotification?.(method, params)
    notify('turn/started', { threadId: THREAD, turn: { id: 'turn-1' } })
    notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } })
    notify('item/started', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-1',
        kind: 'started',
        agentThreadId: CHILD,
        agentPath: '/root/review'
      }
    })
    const subject = expect.objectContaining({ kind: 'structured-session', sessionId: SESSION })
    expect(childWork).toEqual([
      [
        subject,
        [
          expect.objectContaining({
            type: 'live',
            child: expect.objectContaining({
              handle: { idKind: 'thread_id', id: CHILD, runId: 'child-turn-1' },
              description: 'review'
            })
          })
        ],
        'codex'
      ]
    ])
    // The provider dies: its session's end is reported under the same address.
    connections[0]?.onExit?.(new Error('scripted provider exit'))
    expect(childWork.at(-1)).toEqual([
      subject,
      [expect.objectContaining({ type: 'session-ended' })],
      'codex'
    ])
  })
})

describe('Codex background-only resume through hook shutdown', () => {
  let harness: StructuredCodexRpcHarness | null = null
  let server: AgentHookServer | null = null

  afterEach(async () => {
    await harness?.dispose()
    harness = null
    server?.stop()
    server = null
  })

  it.each([
    { trigger: 'quit', kind: 'agent', settled: false },
    { trigger: 'update', kind: 'agent', settled: false },
    { trigger: 'quit', kind: 'command', settled: false },
    { trigger: 'update', kind: 'command', settled: false },
    { trigger: 'update', kind: 'command', settled: true }
  ] as const)(
    '$trigger with a background $kind (settled: $settled)',
    async ({ trigger, kind, settled }) => {
      const runtime = await openStructuredCodexRpcHarness()
      harness = runtime
      const store = new AgentHookServer()
      server = store
      const config = {
        ...runtime.hostConfig(),
        resolveWorkspacePath: async () => runtime.root,
        statusSink: {
          publish: (summary, subject) => store.ingestStructuredStatus(summary, subject),
          forget: (subject) => store.dropStructuredStatus(subject),
          publishChildWork: (subject, evidence, provider) =>
            store.ingestStructuredChildWork(subject, evidence, provider),
          readChildWork: (subject) => store.getStructuredChildWorkViews(subject)
        } satisfies StructuredAgentSessionStatusSink
      }
      const host = await ensureStructuredAgentSessionHost(config)
      const params = hostTestAttachParams(null, {
        providerHandle: undefined,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'folder'
        }
      })
      params.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
      expect(await host.attach({ callerKey: 'restart-test' }, params)).toMatchObject({ ok: true })
      const notify = runtime.codex.notify
      notify('turn/started', { threadId: RESTART_THREAD, turn: { id: 'lead-turn' } })
      if (kind === 'agent') {
        notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn' } })
        notify('item/started', {
          threadId: RESTART_THREAD,
          turnId: 'lead-turn',
          item: {
            type: 'subAgentActivity',
            id: 'spawn-1',
            kind: 'started',
            agentThreadId: CHILD,
            agentPath: '/root/review'
          }
        })
      } else {
        const command = {
          type: 'commandExecution',
          id: 'command-1',
          command: 'npm run build',
          source: 'unifiedExecStartup'
        }
        notify('item/started', {
          threadId: RESTART_THREAD,
          turnId: 'lead-turn',
          item: { ...command, status: 'inProgress' }
        })
        if (settled) {
          notify('item/completed', {
            threadId: RESTART_THREAD,
            turnId: 'lead-turn',
            item: { ...command, status: 'completed', exitCode: 0 }
          })
        }
      }
      notify('turn/completed', {
        threadId: RESTART_THREAD,
        turn: { id: 'lead-turn', status: 'completed' }
      })
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() =>
        expect(store.getStatusSnapshot().find((entry) => entry.structuredHost)).toMatchObject({
          state: settled ? 'done' : 'working',
          mainAgent: { state: 'done' }
        })
      )
      // The real quit starts async chat teardown, then synchronously stops hook ingress.
      const stopping = stopStructuredAgentSessionRuntime({ trigger })
      store.stop({ keepStatus: true })
      await stopping
      expect(
        store
          .getStructuredChildWorkViews(makeStructuredAgentStatusSubject(params.location, SESSION))
          .filter((child) => child.state !== 'done')
      ).toEqual([])
      const activity = {
        state: 'done',
        prompts: [],
        tasks: [{ kind, label: kind === 'agent' ? 'review' : 'npm run build' }]
      }
      const markers = await new AgentSessionRecoveryCapsule(runtime.root).list(Date.now())
      const restarted = await ensureStructuredAgentSessionHost(config)
      const candidates = await restarted.restartResume.list()
      if (settled) {
        expect(markers).toEqual([])
        expect(candidates).toEqual([])
      } else {
        expect(markers).toMatchObject([{ sessionId: SESSION, trigger, activity }])
        expect(candidates).toMatchObject([
          { sessionId: SESSION, agent: 'codex', workspaceKind: 'folder', trigger, activity }
        ])
      }
    }
  )
})
