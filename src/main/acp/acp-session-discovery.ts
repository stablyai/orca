import type { AcpAgentConnection } from './acp-agent-connection'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import type { AtRestCommandScan } from '../native-chat/agent-session-wire/at-rest-command-catalog'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpStructuredOptions } from './acp-structured-options'

export type AcpDiscoveryConnection = Pick<
  AcpAgentConnection,
  | 'initialize'
  | 'start'
  | 'deleteSession'
  | 'subscribe'
  | 'close'
  | 'onExit'
  | 'rootVerdict'
  | 'lastCloseResult'
>

/** Cancellation stops ownership waits; continuations must still check before effects. */
export async function awaitAcpDiscovery<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = () => rejectAbort(signal.reason)
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  signal.addEventListener('abort', aborted, { once: true })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

/** Availability can answer before managed teardown; its owner must retain completion. */
export function runAcpSessionDiscovery<T>(
  connection: AcpDiscoveryConnection,
  signal: AbortSignal,
  body: (check: () => void) => Promise<T>
): {
  answer: Promise<T>
  completion: Promise<{ result: ProviderProcessCloseResult | null; error?: unknown }>
} {
  let closing = false
  const check = () => {
    signal.throwIfAborted()
    if (closing) {
      throw new Error('ACP discovery closed')
    }
  }
  const answer = awaitAcpDiscovery(
    Promise.resolve().then(() => {
      check()
      return body(check)
    }),
    signal
  )
  const completion = answer
    .then(
      () => {},
      () => {}
    )
    .then(async () => {
      closing = true
      try {
        await connection.close()
        return { result: connection.lastCloseResult }
      } catch (error) {
        return { result: connection.lastCloseResult, error }
      }
    })
  return { answer, completion }
}

/** Reads the commands a throwaway session reports, deleting it when the agent can; without
 *  `disposableStorage` an agent that cannot delete is not asked. */
export async function readAcpSessionCommands(input: {
  connection: AcpDiscoveryConnection
  dialect: AcpDialect
  cwd: string
  signal: AbortSignal
  check: () => void
  disposableStorage: boolean
  logger?: StructuredAgentSessionLogger
}): Promise<AtRestCommandScan> {
  const { connection, signal, check } = input
  const options = new AcpStructuredOptions(input.dialect)
  let nativeId: string | undefined
  let provisional:
    | { sessionId: string; commands: Parameters<AcpStructuredOptions['adoptCommands']>[0] }
    | undefined
  let reported: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    reported = resolve
  })
  const unsubscribe = connection.subscribe((event) => {
    if (
      signal.aborted ||
      event.kind !== 'known' ||
      event.notification.update.sessionUpdate !== 'available_commands_update'
    ) {
      return
    }
    const { sessionId, update } = event.notification
    if (nativeId !== undefined && sessionId !== nativeId) {
      return
    }
    provisional = { sessionId, commands: update.availableCommands }
    if (nativeId !== undefined) {
      options.adoptCommands(update.availableCommands)
      reported()
    }
  })
  try {
    const initialized = await awaitAcpDiscovery(connection.initialize(), signal)
    options.adoptInitialize(initialized)
    check()
    const deletes = Boolean(initialized.agentCapabilities?.sessionCapabilities?.delete)
    if (!deletes && !input.disposableStorage) {
      return { commands: undefined, fromAgent: false }
    }
    const started = await awaitAcpDiscovery(
      connection.start({ cwd: input.cwd, mcpServers: [] }),
      signal
    )
    nativeId = started.sessionId
    try {
      check()
      if (provisional?.sessionId === nativeId) {
        options.adoptCommands(provisional.commands)
        reported()
      }
      await awaitAcpDiscovery(ready, signal)
      check()
      return { commands: options.readCommands(), fromAgent: true }
    } finally {
      // Best effort: a cancelled scan can close the agent before the delete lands.
      if (deletes) {
        await connection.deleteSession(started.sessionId).catch((error: unknown) => {
          input.logger?.warn('ACP command discovery kept its session', {
            scope: 'acp-command-discovery',
            error
          })
        })
      }
    }
  } finally {
    unsubscribe()
  }
}
