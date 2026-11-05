import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../../codex/app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from '../../codex/app-server/codex-app-server-connection'

export type CodexScript = {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  live: () => FakeConnection
  notify: (method: string, params: unknown) => void
  ask: (id: number, method: string, params: unknown) => void
}

// `closed` is readonly on the real connection; the fake flips it so the test can
// see the takeover reap the previous child.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number }[]
  resumedThreadId: string | null
  launch: Parameters<typeof openCodexAppServerConnection>[0]
}

export function fakeCodex(threadId: string, turnId: string): CodexScript {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      resumedThreadId: null,
      pid: 4321,
      closed: false,
      get closeResult(): CodexAppServerConnection['closeResult'] {
        return connection.closed ? { root: 'exited', tree: 'exited' } : null
      },
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/goal/get') {
          return { goal: null }
        }
        if (method === 'thread/start') {
          return { thread: { id: threadId, path: '/rollouts/integration.jsonl' } }
        }
        if (method === 'thread/resume') {
          connection.resumedThreadId = (params as { threadId: string }).threadId
          return { thread: { id: connection.resumedThreadId } }
        }
        if (method === 'turn/start') {
          return { turn: { id: turnId } }
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: null
          }
        }
        return {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code) => connection.replies.push({ id, code }),
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  const live = (): FakeConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no codex app-server has been opened')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    notify: (method, params) => live().handlers.onNotification?.(method, params),
    ask: (id, method, params) => live().handlers.onServerRequest?.({ id, method, params })
  }
}
