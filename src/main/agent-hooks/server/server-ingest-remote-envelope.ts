/** Envelope shape accepted from the relay JSON-RPC channel by `ingestRemote`. */
export type RemoteIngestEnvelope = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  launchToken?: string
  hasExplicitPrompt?: boolean
  promptInteractionKey?: string
  agentPresence?: unknown
  hookEventName?: string
  source?: unknown
  providerPromptId?: unknown
  grokPromptBoundary?: unknown
  compactTrigger?: unknown
  toolUseId?: string
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: unknown
  providerSessionOnly?: unknown
  isReplay?: boolean
  /** Payload fields the relay dropped to fit an oversized frame; validated below. */
  shedFields?: unknown
  claudeRunningNonAgentTask?: unknown
  /** The producing peer's advertised run-capability set — a property of the peer/connection that built this envelope, not an orthogonal call parameter. Absent (older relay/HTTP paths) defaults to the unadvertised-legacy-peer set. */
  advertisedAgentStatusCapabilities?: readonly string[]
  statusUnavailable?: unknown
  evidenceAgeMs?: unknown
  contextUsage?: unknown
  contextSessionId?: unknown
  payload?: unknown
}
