// One live ZCode structured session: the connection, its journal translator, and the
// reverse-RPC prompts it is waiting on. Split from the adapter class so the
// acquire/close/prompt modules share one state shape.

import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodeAppServerConnection } from './zcode-app-server-connection-types'
import type { openZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeJournalTranslator } from './zcode-structured-journal-translation'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
import type {
  ComposedStructuredLaunch,
  StructuredAgentLaunchResolver
} from '../runtime/structured-agent-launch-composition'

/** One reverse-RPC approval/question the child asked and Orca has not answered. */
export type ZcodeLivePrompt = {
  itemId: string
  kind: 'approval' | 'question'
  /** The child's reverse-request id, answered through `connection.respond`. */
  requestId: number | string
  method: string
  params: unknown
}

export type ZcodeStructuredSession = {
  connection: ZcodeAppServerConnection
  /** The ZCode session id the child minted or resumed, from the create/resume snapshot; null
   *  until the host opens the child, which is when create or resume runs. */
  providerSessionId: string | null
  /** The adapter's generation for this child, distinct across acquisitions of one record. */
  acquisitionGeneration: string
  /** The lease fence this child was acquired under, carried on its `ended` event. */
  fence: number
  translator: ZcodeJournalTranslator | null
  /** Set once the child's exit is observed; the adapter emits `ended` from it. */
  ended: boolean
  exitObservedAt: number | null
  /** True when a close asked for this exit, so recovery does not relaunch it. */
  orcaClose: boolean
  prompts: Map<string, ZcodeLivePrompt>
  /** The options the session's create carried; the child has no read-back surface. */
  options: Map<string, string>
  launch: ComposedStructuredLaunch<ZcodeStructuredLaunch>
  /** The conversation the record proved, resumed at open instead of creating a new one. */
  resumeSessionId: string | null
  /** The host's sink, kept for the open's backpressure binding. */
  events?: StructuredAgentSessionEventSink
  /** Releases the journal sink's backpressure binding; every close path calls it. */
  unbindReadingControl?: () => void
}

export type ZcodeStructuredSessionAdapterDeps = {
  resolveLaunch: StructuredAgentLaunchResolver<ZcodeStructuredLaunch>
  /** The host's lifecycle listener: every exit, expected or not, ends the record. */
  onEvent?: (event: StructuredAgentSessionEndedEvent) => void
  /** The connection saw the child die; the adapter owns turning that into `onEvent`. */
  onExitObserved?: (error: Error) => void
  logger?: StructuredAgentSessionLogger
  openConnection?: typeof openZcodeAppServerConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
}

export type ZcodeProcessIdentityInput = {
  pid: number
  processStartTimeMs: number | null
}

export function zcodeProcessIdentity(
  input: ZcodeProcessIdentityInput,
  hostId: string,
  spawnToken: string
): AgentSessionProcessIdentity {
  return {
    hostId,
    pid: input.pid,
    processStartTimeMs: input.processStartTimeMs,
    spawnToken
  }
}
