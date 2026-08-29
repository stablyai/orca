import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredTuiOwner = {
  terminal: { handle: string; tabId: string; paneKey: string; ptyId: string }
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
  transcriptPath?: string
  /** Codex app-server resume, not row-by-row legacy import, restores this owner's history. */
  historySource?: 'provider-resume'
  /** This owner came from an existing terminal view rather than a structured-session tab. */
  adoptedTerminal?: true
}

export class StructuredTuiLaunchCleanupError extends Error {
  constructor(
    launchError: unknown,
    readonly cleanupError: unknown
  ) {
    super('The failed terminal launch could not be proven stopped.', { cause: launchError })
    this.name = 'StructuredTuiLaunchCleanupError'
  }
}

export type StructuredAgentSessionHandoffTransport = {
  hostLabel: string
  launchTui(input: {
    record: AgentSessionRecord
    fence: number
    spawnToken: string
    onSpawned?: (owner: StructuredTuiOwner) => Promise<void>
  }): Promise<StructuredTuiOwner>
  reproveTuiOwner(input: {
    record: AgentSessionRecord
    owner: StructuredTuiOwner
  }): Promise<StructuredTuiOwner>
  recoverTuiOwner(record: AgentSessionRecord): Promise<StructuredTuiOwner>
  probeRecoveredOwner?(record: AgentSessionRecord): Promise<'live' | 'dead' | 'unknown'>
  stopRecoveredOwner(record: AgentSessionRecord): Promise<void>
  closeTuiOwner?(owner: StructuredTuiOwner): Promise<{ transcriptPath?: string }>
  revealNativeSession?(input: {
    workspaceId: string
    sessionId: string
    agent?: 'claude' | 'codex'
    adoptedTerminal?: true
  }): void
  waitForTuiExit(owner: StructuredTuiOwner): Promise<{ transcriptPath?: string }>
  waitForTuiIdleOrExit(
    owner: StructuredTuiOwner,
    signal: AbortSignal
  ): Promise<'idle' | 'exited' | null>
  tuiStatus(owner: StructuredTuiOwner): 'idle' | 'busy'
  stopFailedTuiLaunch?(owner: StructuredTuiOwner): Promise<void>
}

export type StructuredNativeSuspendResult =
  | { state: 'live' }
  | { state: 'stopped' }
  | { state: 'stopped-cleanup-failed'; error: unknown }

export type StructuredAgentSessionHandoffDeps = {
  store: AgentSessionRecordStore
  claimKeyId: string
  transport?: StructuredAgentSessionHandoffTransport
  session: (sessionId: string) => { journal: AgentSessionJournal; fence: number }
  suspendNative: (sessionId: string) => Promise<StructuredNativeSuspendResult>
  acquireNative: (input: {
    sessionId: string
    fence: number
    spawnToken: string
  }) => Promise<AgentSessionRecord>
  acquireNativeStop?: (sessionId: string, turnId: string, fence: number) => Promise<boolean>
  importTuiHistory: (input: {
    sessionId: string
    fence: number
    transcriptPath?: string
  }) => Promise<void>
  prepareTuiHistoryCatchup?: (sessionId: string, fence: number) => Promise<void>
  recoverTuiHistoryCatchup?: (sessionId: string, fence: number) => Promise<void>
  activateTuiHistoryCatchup?: (sessionId: string) => Promise<void>
  stopTuiHistoryCatchup?: (sessionId: string) => void
  publish: (sessionId: string, status: AgentSessionHandoffStatus) => void
  schedule: (sessionId: string, task: () => Promise<void>) => Promise<void>
  now: () => number
  /** Persist a provider handle observed while re-proving a TUI owner. */
  persistTuiProviderHandle?: (input: {
    sessionId: string
    link: AgentSessionProviderHandleLink
    now: number
  }) => Promise<void>
}

export type StructuredAgentSessionHandoffFlowContext = {
  deps: StructuredAgentSessionHandoffDeps
  owner: (sessionId: string) => StructuredTuiOwner | undefined
  retainOwner: (sessionId: string, owner: StructuredTuiOwner) => void
  releaseOwner: (sessionId: string) => void
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
  enterPreparing: (
    record: AgentSessionRecord,
    operationId: string,
    direction: 'to-tui' | 'to-native'
  ) => Promise<void>
  publishStage: (record: AgentSessionRecord, direction: 'to-tui' | 'to-native') => void
  requireRecord: (sessionId: string) => AgentSessionRecord
}
