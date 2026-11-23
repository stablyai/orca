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
import { claudeKeptAgentFinishingInput, type ClaudeKeptAgentInput } from './claude-kept-agent-input'
import { claudeStreamJsonExitError } from '../sdk-transport/claude-stream-json-exit-error'
import { withLostProviderOutcome } from '../../provider-process/provider-process-exit-status'
import { withObservedProviderExit } from '../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { ClaudeControlRequestError } from '../sdk-transport/claude-agent-sdk-control-requests'
import { relayedClaudeChildTree } from './claude-relayed-child-tree'

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

/** Lines the SDK consumes itself and never yields as messages. */
const TRANSPORT_TYPES = new Set(['control_response', 'keep_alive', 'transcript_mirror'])

/**
 * The chat's Claude agent that kept running under the terminal daemon while Orca was closed, with
 * no SDK: its output since the last ack is replayed as messages, and the requests it holds are
 * answered by the chat's own handlers. Null when the chat has no kept agent.
 */
export async function openKeptClaudeAgentConnection(
  chatKey: string,
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  inputFor: (end: () => Promise<unknown>) => ClaudeKeptAgentInput = claudeKeptAgentFinishingInput
): Promise<ClaudeKeptAgentConnection | null> {
  // Reattach only: nothing is spawned, so the command is never run.
  const kept = { command: launch.pathToClaudeCodeExecutable, args: [], cwd: launch.cwd }
  const relayed = await launchRelayedProviderProcess(kept, {
    only: 'reattach',
    chatKey,
    markers: CLAUDE_RELAY_WORK_MARKERS,
    // Everything waits for the chat to publish the session, then flows in order.
    passWhileHeld: () => false
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
  const write = (line: string): void => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(line)
    }
  }
  const responder = new ClaudeKeptAgentResponder(handlers, launch.options.hooks, write)

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
    if (!isRecord(message) || responder.observe(message)) {
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
      const result = await managed.closeWriter(
        relayedClaudeChildTree(() => managed.rootVerdict === 'exited'),
        options
      )
      if (result.root !== 'exited') {
        closePromise = null
        return false
      }
      return true
    })()
    return closePromise
  }
  const input = inputFor(() => close())
  const unavailable = <T>(subtype: string): Promise<T> => input.control<T>(subtype)
  const initialization = keptInitialization(child.initializeLine)

  return {
    kept: { releaseOutput: () => child.releaseOutput() },
    interrupt: () => input.interrupt(),
    cancelAsyncMessage: () => Promise.resolve(false),
    setModel: () => unavailable('set_model'),
    setPermissionMode: () => unavailable('set_permission_mode'),
    applyFlagSettings: () => unavailable('apply_flag_settings'),
    stopTask: () => unavailable('stop_task'),
    backgroundTask: () => unavailable('background_tasks'),
    supportedModels: () =>
      Promise.resolve(
        isRecord(initialization) && Array.isArray(initialization.models)
          ? initialization.models
          : []
      ),
    mcpServerStatus: () => unavailable('mcp_status'),
    initializationResult: () =>
      terminalError
        ? Promise.reject(new ClaudeControlRequestError('initialize', terminalError.message))
        : Promise.resolve(initialization),
    getSettings: () => unavailable('get_settings'),
    getContextUsage: () => unavailable('get_context_usage'),
    renameSession: () => unavailable('rename_session'),
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
    send: (message, beforeDispatch) => input.send(message, beforeDispatch),
    close
  }
}
