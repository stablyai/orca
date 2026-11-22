import { expect } from 'vitest'
import { CodexAppServerUnsupportedError } from '../codex-app-server-request-error'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { CodexSharedServerPool } from './codex-shared-server-pool'
import type { CodexSharedServerWindowsJob } from './codex-shared-server-windows-job'
import { codexOpenedThreadId } from './codex-shared-server-frames'

/** A scripted Codex app-server and chat handlers for the shared-server tests. */
export type FakeServer = {
  pid: number
  handlers: CodexAppServerConnectionHandlers
  requests: { method: string; params?: Record<string, unknown> }[]
  /** Background terminals per thread, as Codex lists them. */
  terminals: Map<string, Set<string>>
  /** Whether Orca stopped reading this server's output. */
  readingPaused: boolean
  /** Server requests Orca answered with an error. */
  refused: (number | string)[]
  /** Answers the thread/start held by `holdOpen`. */
  releaseOpen: () => void
  crash: () => void
  /** The server goes unusable without its exit being proven yet. */
  closeTransport: () => void
}

/** interrupt: 'ends' completes the turn at once, 'later' after 3 s, 'ignored' never. */
export function fakeCodex(
  interrupt: 'ends' | 'later' | 'ignored' = 'ends',
  /** What closing the process proves about its commands. */
  closeTree: 'exited' | 'unverifiable' = 'exited',
  /** Whether thread/backgroundTerminals/terminate actually stops the command. */
  terminateWorks = true,
  codex: {
    listUnsupported?: boolean
    unsubscribeFails?: boolean
    windowsJob?: () => CodexSharedServerWindowsJob
  } = {}
) {
  const servers: FakeServer[] = []
  let nextThread = 1
  const connect = async (
    _launch: unknown,
    handlers: CodexAppServerConnectionHandlers = {}
  ): Promise<CodexAppServerConnection> => {
    let closed = false
    let closeResult: CodexAppServerConnection['closeResult'] = null
    const held: (() => void)[] = []
    const server: FakeServer = {
      pid: 5000 + servers.length,
      handlers,
      requests: [],
      terminals: new Map(),
      readingPaused: false,
      refused: [],
      releaseOpen: () => {},
      crash: () => {
        closed = true
        handlers.onClose?.(new Error('codex crashed'))
        handlers.onExit?.(new Error('codex crashed'), { expected: false })
      },
      closeTransport: () => {
        closed = true
        handlers.onClose?.(new Error('broken pipe'))
      }
    }
    servers.push(server)
    return {
      pid: server.pid,
      get closed() {
        return closed
      },
      get closeResult() {
        return closeResult
      },
      request: async (method, params, options) => {
        // A paused reader gets no replies, as on a real pipe.
        while (server.readingPaused) {
          await new Promise<void>((resume) => held.push(resume))
        }
        server.requests.push({ method, ...(params ? { params } : {}) })
        if (method === 'turn/start' && params?.hang === true) {
          // A send Codex has not answered yet.
          return new Promise(() => {})
        }
        if (
          (method === 'thread/start' || method === 'thread/resume') &&
          params?.holdOpen === true
        ) {
          const id =
            typeof params.threadId === 'string' ? params.threadId : `thread-${nextThread++}`
          return new Promise((resolve) => {
            server.releaseOpen = () => {
              const result = { thread: { id } }
              options?.onReply?.(result)
              resolve(result)
            }
          })
        }
        const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
        if (method === 'thread/resume' && params?.gone === true) {
          throw new Error('codex app-server thread/resume failed: no rollout found')
        }
        if (method === 'thread/backgroundTerminals/list' && codex.listUnsupported) {
          throw new CodexAppServerUnsupportedError('codex app-server does not support list')
        }
        if (method === 'thread/unsubscribe' && codex.unsubscribeFails) {
          throw new Error('codex app-server thread/unsubscribe failed')
        }
        if (method === 'thread/backgroundTerminals/list') {
          const running = [...(server.terminals.get(threadId) ?? [])]
          const result = { data: running.map((processId) => ({ processId })), nextCursor: null }
          options?.onReply?.(result)
          return result
        }
        if (method === 'thread/backgroundTerminals/terminate' && terminateWorks) {
          server.terminals.get(threadId)?.delete(String(params?.processId))
        }
        let result: unknown = {}
        if (method === 'thread/start') {
          const id = `thread-${nextThread++}`
          // Codex announces the thread before it answers the start.
          handlers.onNotification?.('thread/started', { thread: { id } })
          result = { thread: { id } }
        } else if (method === 'thread/resume') {
          // History naming helpers that ran on an earlier server.
          const helpers = typeof params?.historyHelpers === 'number' ? params.historyHelpers : 0
          const items = Array.from({ length: helpers }, (_, index) => ({
            type: 'collabAgentToolCall',
            id: `spawn-${index}`,
            tool: 'spawnAgent',
            receiverThreadIds: [`helper-${index}`]
          }))
          result = { thread: { id: params?.threadId, ...(helpers ? { turns: [{ items }] } : {}) } }
        } else if (method === 'turn/interrupt' && interrupt !== 'ignored') {
          const end = () =>
            handlers.onNotification?.('turn/completed', {
              threadId: params?.threadId,
              turn: { id: params?.turnId, status: 'interrupted' }
            })
          if (interrupt === 'ends') {
            end()
          } else {
            setTimeout(end, 3_000)
          }
        }
        options?.onReply?.(result)
        return result
      },
      pauseReading: () => {
        server.readingPaused = true
      },
      resumeReading: () => {
        server.readingPaused = false
        for (const resume of held.splice(0)) {
          resume()
        }
      },
      notify: () => {},
      respond: () => {},
      respondWithError: (id) => {
        server.refused.push(id)
      },
      close: async () => {
        closed = true
        closeResult = { root: 'exited', tree: closeTree }
        handlers.onExit?.(new Error('closed'), { expected: true })
        return true
      }
    }
  }
  // The host sweep finds nothing left of a chat unless a test leaves something running.
  const sweep = { leftovers: false }
  return {
    servers,
    sweep,
    pool: withKnownVersion(
      new CodexSharedServerPool(
        connect,
        async () => !sweep.leftovers,
        codex.windowsJob ?? (() => undefined)
      )
    )
  }
}

export function chat() {
  const notifications: { method: string; params: unknown }[] = []
  const exits: { message: string; expected: boolean | undefined }[] = []
  const handlers: CodexAppServerConnectionHandlers = {
    onNotification: (method, params) => notifications.push({ method, params }),
    onExit: (error, exit) => exits.push({ message: error.message, expected: exit?.expected })
  }
  return { handlers, notifications, exits }
}

export const launch = (home = '/home/a/.codex') => ({
  command: '/usr/local/bin/codex',
  args: ['app-server'],
  cwd: '/work',
  env: { CODEX_HOME: home, ORCA_AGENT_SESSION_ID: `chat-${Math.random()}` }
})

export async function startThread(connection: CodexAppServerConnection): Promise<string> {
  const threadId = codexOpenedThreadId(await connection.request('thread/start', { cwd: '/work' }))
  expect(threadId).not.toBeNull()
  return threadId ?? ''
}

/** Chats share only a Codex whose version is known; the tests' launches all report one. */
function withKnownVersion(pool: CodexSharedServerPool): CodexSharedServerPool {
  const open = pool.open.bind(pool)
  pool.open = (launch, handlers, options) =>
    open(launch, handlers, { codexVersion: 'codex-cli 0.167.0', ...options })
  return pool
}
