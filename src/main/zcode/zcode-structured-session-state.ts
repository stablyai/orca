// One live ZCode structured session: the connection, its journal translator, and the
// reverse-RPC prompts it is waiting on. Split from the adapter class so the
// acquire/close/prompt modules share one state shape.

import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodeAppServerConnection } from './zcode-app-server-connection-types'
import type { openZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeJournalTranslator } from './zcode-structured-journal-translation'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'

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
  /** The ZCode session id the child minted or resumed, from the create/resume snapshot. */
  providerSessionId: string
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
  launch: ZcodeStructuredLaunch
}

export type ZcodeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<ZcodeStructuredLaunch>
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
