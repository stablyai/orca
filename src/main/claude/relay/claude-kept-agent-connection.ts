import { finished } from 'node:stream/promises'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnectionHandlers,
  type ClaudeStreamJsonLaunch
} from '../claude-stream-json-connection'
import { launchRelayedProviderProcess } from '../../provider-relay/app-provider-relays'
import { CLAUDE_RELAY_WORK_MARKERS } from './claude-relay-markers'
import { ClaudeKeptAgentResponder } from './claude-kept-agent-responder'
import { ClaudeKeptAgentQuery } from './claude-kept-agent-query'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  claudeUnwrittenUserMessageError,
  createClaudeUserMessageQueue
} from '../sdk-transport/claude-agent-sdk-user-message-queue'
import { claudeStreamJsonExitError } from '../sdk-transport/claude-stream-json-exit-error'
import { withLostProviderOutcome } from '../../provider-process/provider-process-exit-status'
import { withObservedProviderExit } from '../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { createClaudeControlSurface } from '../sdk-transport/claude-agent-sdk-control-requests'
import { relayedClaudeChildTree } from './claude-relayed-child-tree'
import { DaemonProtocolError } from '../../daemon/protocol/daemon-errors'

/** Present on a connection to an agent that kept running while Orca was closed. */
export type ClaudeKeptAgentRelay = {
  /** Lets the kept output through once the chat can route it. */
  releaseOutput: () => void
}

export type ClaudeKeptAgentConnection = ClaudeStreamJsonConnection & {
  readonly kept: ClaudeKeptAgentRelay
}

/** The kept-agent side of a connection, when it is one. */
export function keptClaudeAgentRelay(
  connection: ClaudeStreamJsonConnection
): ClaudeKeptAgentRelay | null {
  return isKeptConnection(connection) ? connection.kept : null
}

function isKeptConnection(
  connection: ClaudeStreamJsonConnection
): connection is ClaudeKeptAgentConnection {
  return 'kept' in connection
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The kept agent's answer to the first app's `initialize`. */
function keptInitialization(line: string | null): unknown {
  if (line === null) {
    return {}
  }
  try {
    const message: unknown = JSON.parse(line)
    const response = isRecord(message) && isRecord(message.response) ? message.response : null
    return response && 'response' in response ? response.response : {}
  } catch {
    return {}
  }
}

/**
 * Opens a chat's Claude connection: the agent kept running while Orca was closed, else a new one
 * (under the terminal daemon where it can, so it outlives the next restart).
 */
export function claudeChatConnectionOpener(
  /** Null keeps today's launch (a bot's chat, whose grants end with this run). */
  chatKey: string | null,
  open: typeof openClaudeStreamJsonConnection = openClaudeStreamJsonConnection
): (
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers
) => Promise<ClaudeStreamJsonConnection> {
  if (chatKey === null) {
    return (launch, handlers) => open(launch, handlers)
  }
  return async (launch, handlers) =>
    (await openKeptClaudeAgentConnection(chatKey, launch, handlers)) ??
    open({ ...launch, relayChatKey: chatKey }, handlers)
}

/** The agent had already ended, or the daemon answered with a refusal; a lost reply proves nothing. */
function relayWriteNeverReachedAgent(error: Error): boolean {
  return ('code' in error && error.code === 'EPIPE') || !(error instanceof DaemonProtocolError)
}

/** Lines the SDK consumes itself and never yields as messages. */
const TRANSPORT_TYPES = new Set(['keep_alive', 'transcript_mirror'])

/**
 * The chat's Claude agent that kept running under the terminal daemon while Orca was closed,
 * driven without the SDK but in its wire format: output since the last ack is replayed as
 * messages, held requests are answered by the chat's own handlers, and the chat's messages, Stop
 * and setting changes go to the agent exactly as the SDK would write them. Null when the chat has
 * no kept agent; once it ends, the next message cold-resumes as usual.
 */
export async function openKeptClaudeAgentConnection(
  chatKey: string,
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {}
): Promise<ClaudeKeptAgentConnection | null> {
  let query: ClaudeKeptAgentQuery | null = null
  // Reattach only: nothing is spawned, so the command is never run.
  const kept = { command: launch.pathToClaudeCodeExecutable, args: [], cwd: launch.cwd }
  const relayed = await launchRelayedProviderProcess(kept, {
    only: 'reattach',
    chatKey,
    markers: CLAUDE_RELAY_WORK_MARKERS,
    // Answers to this app's own requests pass; everything else waits for the chat to open.
    passWhileHeld: (line) => query?.answers(line) === true
  })
  if (!relayed) {
    return null
  }
  const { managed, child } = relayed
  const exited = Promise.withResolvers<Error>()
  let closing = false
  let terminalError: Error | null = null
  let closePromise: Promise<boolean> | null = null
  let readingBarrier: PromiseWithResolvers<void> | null = null
  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        return
      }
      child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
    })
  const initialization = keptInitialization(child.initializeLine)
  const keptQuery = new ClaudeKeptAgentQuery(write, initialization)
  query = keptQuery
  const responder = new ClaudeKeptAgentResponder(handlers, launch.options.hooks, (line) => {
    void write(line).catch(() => {})
  })
  const inbox = createClaudeUserMessageQueue()
  const lines: string[] = []
  let partial = ''
  let draining: Promise<void> = Promise.resolve()
  // One drain at a time, so lines keep their order across a paused read.
  const pump = (): Promise<void> => {
    draining = draining.then(async () => {
      for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
        await readingBarrier?.promise
        deliver(line)
      }
    })
    return draining
  }
  const deliver = (line: string): void => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(message) || responder.observe(message) || keptQuery.observe(message)) {
      return
    }
    if (typeof message.type === 'string' && TRANSPORT_TYPES.has(message.type)) {
      return
    }
    handlers.onMessage?.(message)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    handlers.onStdout?.(chunk)
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
    for (const part of parts) {
      if (part.length > 0) {
        lines.push(part)
      }
    }
    void pump()
  })

  const onEnd = (): void => {
    if (terminalError) {
      return
    }
    readingBarrier?.resolve()
    readingBarrier = null
    responder.dispose()
    terminalError = withLostProviderOutcome(
      claudeStreamJsonExitError(managed.stderrTail(), managed.exitStatus),
      child
    )
    keptQuery.close()
    // Messages it never took are provably unwritten; the next send cold-resumes with a new agent.
    inbox.fail(terminalError)
    if (!closing) {
      withObservedProviderExit(terminalError)
      handlers.onFault?.(terminalError)
    }
    handlers.onExit?.(terminalError, { expected: closing })
    exited.resolve(terminalError)
  }
  managed.onExit(() => {
    // Output already relayed reaches the chat before its exit does.
    void finished(child.stdout)
      .catch(() => {})
      .then(() => {
        if (partial.length > 0) {
          lines.push(partial)
          partial = ''
        }
        return pump()
      })
      .finally(onEnd)
  })

  const close: ClaudeStreamJsonConnection['close'] = (options) => {
    closePromise ??= (async () => {
      closing = true
      readingBarrier?.resolve()
      readingBarrier = null
      inbox.end()
      const result = await managed.closeWriter(
        relayedClaudeChildTree(() => managed.rootVerdict === 'exited'),
        options
      )
      inbox.fail(new Error('claude stream-json connection closed'))
      if (result.root !== 'exited') {
        closePromise = null
        return false
      }
      return true
    })()
    return closePromise
  }

  // A message the agent provably never took is unwritten: the dispatch hands it to a new agent.
  void inbox
    .writeEach((message) => write(`${JSON.stringify(message)}\n`), relayWriteNeverReachedAgent)
    .catch((error: unknown) => {
      inbox.fail(error instanceof Error ? error : new Error(String(error)))
      void close()
    })

  return {
    ...createClaudeControlSurface(keptQuery),
    kept: { releaseOutput: () => child.releaseOutput() },
    exited: exited.promise,
    spawned: Promise.resolve(),
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || managed.rootVerdict === 'exited' || terminalError !== null
    },
    executableMissing: false,
    get exitVerdict() {
      const verdict = managed.rootVerdict === 'exited' ? 'exited' : 'live'
      return { root: verdict, tree: verdict } as const
    },
    pauseReading: () => {
      if (!closing && !terminalError) {
        readingBarrier ??= Promise.withResolvers<void>()
      }
    },
    resumeReading: () => {
      readingBarrier?.resolve()
      readingBarrier = null
      void pump()
    },
    send: (message, beforeDispatch) => {
      if (closing || terminalError || managed.rootVerdict === 'exited') {
        return Promise.reject(
          claudeUnwrittenUserMessageError(
            terminalError ?? new Error('claude stream-json connection is closed')
          )
        )
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch constructs the SDK user envelope after mapping every content block.
      return inbox.push(message as unknown as SDKUserMessage, beforeDispatch)
    },
    close
  }
}
