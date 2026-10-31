import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { QueuedRigProviderOptions } from './structured-agent-session-queued-message-rig-provider.test-fixture'

export type RigSendOptions = {
  internal?: true
  from?: AgentMessageSource
  carried?: Readonly<Record<string, string>>
}

export type QueuedMessageRigOptions = QueuedRigProviderOptions & {
  scopedOwnership?: true
  sessionId?: string
  idleSweep?: { idleMs: number; intervalMs: number }
  now?: () => number
  /** Teardown records its restart offers, which `restartOffers` lists. */
  recoveryCapsule?: true
  location?: AgentSessionExecutionLocation
  /** Defaults to indeterminate. */
  probeOwner?: StructuredAgentSessionHostDeps['probeOwner']
}
