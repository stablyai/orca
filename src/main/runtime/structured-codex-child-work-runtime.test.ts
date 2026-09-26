// The production runtime hands a Codex session's child work to the status sink, under the address
// the session's own row landed under, and ends it with the provider.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

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
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      statusSink: {
        publish: () => {},
        forget: () => {},
        publishChildWork: (...args) => childWork.push(args)
      }
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = `${Date.now()}-${'1'.padStart(32, '0')}`
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    expect(attached).toMatchObject({ ok: true })
    await host.hold(SESSION, 'desktop-chat:1')
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
