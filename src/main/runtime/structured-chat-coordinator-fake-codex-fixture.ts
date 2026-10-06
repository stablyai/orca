// A fake Codex app-server for the structured chat coordinator mail tests: it answers the JSON-RPC
// calls the adapter makes, and misbehaves on the knobs in `providerFaults`.

import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { refuseUnroutedSteer } from '../codex/codex-structured-dispatch-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { isRecord } from './rpc/orchestration-session-caller-test-fixture'

const WORKSPACE = 'workspace-1'

export type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  threadId: string | null
  /** Every JSON-RPC method the adapter called, in order. */
  methods: string[]
  turns: { clientUserMessageId: string; text: string }[]
}

/** How the fake provider misbehaves; reset before each test. */
export const providerFaults: {
  dieBeforeEveryEcho: boolean
  refuseTurnStarts: number
  /** Refuses every start with this error while set. */
  refuseStart: (() => Error) | null
  /** How long a start takes before it answers. */
  startDelayMs: number
  /** Kills the app-server while it takes a turn: its exit and the failed call, in either order. */
  crashOnTurnStart: 'off' | 'exit-then-throw' | 'throw-then-exit'
  starts: number
  turnStarts: number
} = {
  dieBeforeEveryEcho: false,
  refuseTurnStarts: 0,
  refuseStart: null,
  startDelayMs: 0,
  crashOnTurnStart: 'off',
  starts: 0,
  turnStarts: 0
}

export function fakeCodex() {
  const connections: FakeConnection[] = []
  let turnCounter = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake answering the JSON-RPC calls the adapter makes, as the shipped integration test does.
  const openConnection = (async (_launch, handlers = {}) => {
    providerFaults.starts += 1
    if (providerFaults.startDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, providerFaults.startDelayMs))
    }
    if (providerFaults.refuseStart) {
      throw providerFaults.refuseStart()
    }
    const connection: FakeConnection = {
      handlers,
      threadId: null,
      methods: [],
      turns: [],
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.methods.push(method)
        const input = isRecord(params) ? params : {}
        if (method === 'thread/start') {
          connection.threadId = `thread-${connections.length}`
          return { thread: { id: connection.threadId } }
        }
        if (method === 'thread/resume') {
          connection.threadId = String(input.threadId)
          return { thread: { id: connection.threadId } }
        }
        if (method === 'turn/start') {
          providerFaults.turnStarts += 1
          if (providerFaults.crashOnTurnStart === 'exit-then-throw') {
            connection.handlers.onExit?.(new Error('app-server crashed'))
            throw new Error('connection closed')
          }
          if (providerFaults.crashOnTurnStart === 'throw-then-exit') {
            setTimeout(() => connection.handlers.onExit?.(new Error('app-server crashed')), 0)
            throw new Error('connection closed')
          }
          if (providerFaults.refuseTurnStarts > 0) {
            providerFaults.refuseTurnStarts -= 1
            throw new Error('turn/start refused')
          }
          turnCounter += 1
          connection.turns.push({
            clientUserMessageId: String(input.clientUserMessageId),
            text: JSON.stringify(input.input)
          })
          if (providerFaults.dieBeforeEveryEcho) {
            setTimeout(() => connection.handlers.onExit?.(new Error('provider died')), 0)
          }
          return { turn: { id: `turn-${turnCounter}` } }
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: null
          }
        }
        if (method === 'turn/steer') {
          return refuseUnroutedSteer(undefined)
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection }
}

let operations = 0
export function operationId(): string {
  operations += 1
  return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
}

export function attachParams(sessionId: string) {
  const params = {
    location: {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: 'codex' as const,
    agent: 'codex' as const,
    accountHome: { variable: 'CODEX_HOME' as const, path: '/home/dev/.codex' },
    runtimeKind: 'native' as const
  }
  const envelope = {
    sessionId,
    clientOperationId: operationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: ''
  }
  return {
    ...params,
    envelope: {
      ...envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId,
        fields: attachFingerprintFields({ ...params, envelope })
      })
    }
  }
}

/** A healthy provider and a fresh id sequence, before each test. */
export function resetProviderFaults(): void {
  operations = 0
  providerFaults.dieBeforeEveryEcho = false
  providerFaults.refuseTurnStarts = 0
  providerFaults.refuseStart = null
  providerFaults.startDelayMs = 0
  providerFaults.crashOnTurnStart = 'off'
  providerFaults.starts = 0
  providerFaults.turnStarts = 0
}
