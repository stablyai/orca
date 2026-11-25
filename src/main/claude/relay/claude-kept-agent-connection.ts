import { finished } from 'node:stream/promises'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnectionHandlers,
  type ClaudeStreamJsonLaunch
} from '../claude-stream-json-connection'
import { launchRelayedProviderProcess } from '../../provider-relay/app-provider-relays'
import { CLAUDE_RELAY_WORK_MARKERS, claudeRelayAttachTaskIds } from './claude-relay-markers'
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
import { feedClaudeKeptModeLines } from './claude-relay-kept-mode'
import { DaemonProtocolError } from '../../daemon/protocol/daemon-errors'

/** Present on a connection to an agent that kept running while Orca was closed. */
export type ClaudeKeptAgentRelay = {
  /** Lets the kept output through once the chat can route it. */
  releaseOutput: () => void
  /** Background tasks open when the last app let go, and those that ended since: this app never
   *  saw them start, so each is restated and the replayed end settles one that ended. */
  taskIds: readonly string[]
  /** False when no app handed the daemon its open work (a crash): the saved rows are the record. */
  workCarried: boolean
  /** Claude's last reported mode as the daemon kept it, when it kept one. */
  confirmedMode: string | null | undefined
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

/** The one note a chat shows when its kept agent couldn't take a message and a new one did; every
 *  message that agent turned away shares it. */
export function noteKeptClaudeAgentReplaced(session: {
  events: StructuredAgentSessionEventSink | undefined
  acquisitionGeneration: string
}): void {
  session.events?.appendItem(
    { provider: 'orca', clientMessageId: `kept-agent-replaced:${session.acquisitionGeneration}` },
    {
      kind: 'status',
      tone: 'neutral',
      text: 'Orca restarted this chat\u2019s agent to send your message.'
    },
    { turnScope: { kind: 'thread' } }
  )
  session.events?.publish()
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
  return (
    ('code' in error && error.code === 'EPIPE') ||
    !(error instanceof DaemonProtocolError) ||
    // The daemon refused before writing: the relay is gone or no longer this app's.
    /^Relay not (found|attached to this client)$/.test(error.message)
  )
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
  const reattachedStdout = handlers.onReattach?.()
  // Ahead of every replayed or pending line, so a waiting request reads the mode Claude confirmed.
  const confirmedMode = feedClaudeKeptModeLines(child, handlers.onStdout)
  const records = child.stdout.relayRecords
  records.claim()
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
  // A broken input leaves the agent waiting on answers it will never get: end it, so the chat's
  // next message starts a new one, rather than leave a turn stuck. Its end is a fault, not a close.
  let inputBroken = false
  const inputBroke = (): void => {
    if (!closing && terminalError === null) {
      inputBroken = true
      void close().catch(() => false)
    }
  }
  child.stdin.on('error', inputBroke)
  const initialization = keptInitialization(child.initializeLine)
  const keptQuery = new ClaudeKeptAgentQuery(write, initialization)
  query = keptQuery
  const responder = new ClaudeKeptAgentResponder(handlers, launch.options.hooks, (line) => {
    void write(line).catch(inputBroke)
  })
  const inbox = createClaudeUserMessageQueue()
  // A head index, not shift(): a replay can be tens of thousands of lines.
  let lines: string[] = []
  let head = 0
  let partial = ''
  let draining: Promise<void> = Promise.resolve()
  // One drain at a time, so lines keep their order across a paused read. No timer may run while
  // lines wait here: an ack then would cover output the chat never got.
  const pump = (): Promise<void> => {
    draining = draining.then(async () => {
      while (head < lines.length) {
        await readingBarrier?.promise
        try {
          deliver(lines[head++])
        } finally {
          // Acks cover only lines the chat took, so a pause or crash here replays the rest.
          records.taken()
        }
      }
      lines = []
      head = 0
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
    reattachedStdout?.(chunk)
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
    const expected = closing && !inputBroken
    if (!expected) {
      withObservedProviderExit(terminalError)
      handlers.onFault?.(terminalError)
    }
    handlers.onExit?.(terminalError, { expected })
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
      const failure = error instanceof Error ? error : new Error(String(error))
      inbox.fail(failure)
      // An unwritten message is handed to a new agent with its note; any other loss is a fault.
      void (relayWriteNeverReachedAgent(failure) ? close() : inputBroke())
    })

  return {
    ...createClaudeControlSurface(keptQuery),
    kept: {
      releaseOutput: () => child.releaseOutput(),
      taskIds: claudeRelayAttachTaskIds(child.attachResult),
      workCarried: child.attachResult?.openWork !== undefined,
      confirmedMode
    },
    exited: exited.promise,
    spawned: Promise.resolve(),
    get handedOff() {
      return child.handedOff
    },
    get pid() {
      return child.pid
    },
    get closed() {
      // An agent that ended while Orca was closed stays open until its last output reaches the chat.
      return closing || terminalError !== null
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
