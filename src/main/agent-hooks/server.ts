/* eslint-disable max-lines -- Why: this file owns the loopback HTTP adapter, the on-disk last-status persistence layer (hydrate, sanitize, TTL, atomic write, drop), and the relay ingest path in one place so the cache lifecycle (set → schedule → drain) lives next to the surfaces that mutate it. Splitting would force mutual `private` accessor scaffolding for a single class. */
// Why: this main-process adapter keeps listener internals in shared/ (`src/shared/agent-hook-listener.ts`) so the relay can host the same pipeline without Electron. See docs/design/agent-status-over-ssh.md §5.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { AGENT_KIND_VALUES, type AgentKind } from '../../shared/telemetry-events'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  clearClaudeAnsweredQuestionWait,
  createHookListenerState,
  getEndpointFileName,
  hasCodexTranscriptSubagents,
  hasPendingAgentResultText,
  HOOK_REQUEST_SLOWLORIS_MS,
  markClaudeLeadTurnInterrupted,
  markCodexLeadTurnInterrupted,
  MAX_PANE_KEY_LEN,
  movePaneCacheState,
  normalizeHookPayload,
  parseFormEncodedBody,
  readRequestBody,
  reapRestoredClaudeSubagentsForDeadPane,
  reconcileRemoteCodexState,
  resolveHookSource,
  preparePendingGrokResultDiscovery,
  seedClaudeSubagentRosterFromSnapshots,
  seedCodexStateFromSnapshot,
  warnOnHookEnvOrVersionMismatch,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../../shared/agent-hook-listener'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots
} from '../../shared/claude-subagent-roster'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import {
  CLAUDE_STATUSLINE_PATHNAME,
  parseClaudeStatusLineBody,
  type ClaudeStatusLineRateLimits
} from '../../shared/claude-statusline-rate-limits'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusClearIpcPayload,
  type AgentStatusIpcPayload,
  type AgentType,
  type AgentStatusState,
  type ParsedAgentStatusPayload,
  normalizeAgentStatusPayload
} from '../../shared/agent-status-types'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../shared/agent-status-identity'
import {
  isAgentInterruptInputIntent,
  type AgentInterruptInferenceRequest
} from '../../shared/agent-interrupt-intent'
import {
  isAskUserQuestionTool,
  type AgentQuestionAnsweredInferenceRequest
} from '../../shared/agent-question-answered-intent'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { LegacyPaneKeyAliasEntry } from '../../shared/types'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import { isCommandCodeNewTurnWhileWorking } from '../../shared/command-code-turn-boundary'

export type { AgentHookSource }

// Why: server-side enrichment — receivedAt = latest event arrival, stateStartedAt = when the current state first appeared; extra fields ride the shared map untouched (it only writes/clears).
type EnrichedAgentHookEventPayload = AgentHookEventPayload & {
  receivedAt: number
  stateStartedAt: number
}

type PersistedAgentHookEventPayload = Omit<
  EnrichedAgentHookEventPayload,
  'launchToken' | 'promptInteractionKey'
> & {
  launchTokenHash?: string
}

type PersistedAgentHookAuthorityCommitment = {
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}

export type AgentHookStatusChangeEntry = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

export type AgentHookProviderSessionIdentity = {
  paneKey: string
  sessionId: string
  transcriptPath?: string
  worktreeId?: string
}

export type AgentHookAuthorityEvidence = Readonly<{
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}>

export type AgentHookAuthorityAttestation = Readonly<{
  paneKey: string
  source: 'current_hook' | 'hydrated_commitment'
}>

type StatusChangeListener = (statuses: AgentHookStatusChangeEntry[]) => void
type ProviderSessionChangeListener = (providerSessions: AgentHookProviderSessionIdentity[]) => void
type PaneStatusClearListener = (clear: AgentStatusClearIpcPayload) => void
type PaneKeyAliasPersistenceListener = (entries: LegacyPaneKeyAliasEntry[]) => void
type PaneKeyAliasEntry = {
  stablePaneKey: string
  ptyId: string | null
  updatedAt: number
  authorityVerified: boolean
}

// Why: co-located with the endpoint file in userData/agent-hooks/ so hook-server cross-restart artifacts stay together.
const LAST_STATUS_FILE_NAME = 'last-status.json'
const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50
const CODEX_SUBAGENT_POLL_MS = 1_000
const INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS = 15_000

// Why: starts at 2 — pre-merge v1 lacked receivedAt/stateStartedAt (never shipped); a mismatched version hydrates empty (treated as corrupt).
const LAST_STATUS_FILE_VERSION = 2

// Why: trailing-edge debounce so a burst of hook events yields one disk write, not N; quit-time flushStatusPersistSync() guarantees the final flush.
const STATUS_PERSIST_DEBOUNCE_MS = 250
const TOOL_PROGRESS_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Why: bound file growth from PTYs that never re-attach; 7 days is the "still relevant?" horizon beyond which entries shouldn't resurrect on hydrate.
const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Why: a long-closed tab can't receive status events; bound the set so it can't grow one entry per close for the whole session.
export const CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const CLOSED_AGENT_STATUS_PANE_KEYS_MAX = 1024
export const PANE_KEY_ALIASES_MAX = 1024

type LastStatusFile = {
  version: number
  entries: Record<string, PersistedAgentHookEventPayload>
  authorityCommitments?: Record<string, PersistedAgentHookAuthorityCommitment>
}

type AgentPromptSentDedupeEntry = {
  agentKind: AgentKind
  promptHash: string
  promptInteractionKey?: string
}

function agentTypeToPromptSentAgentKind(agentType: AgentType | undefined): AgentKind {
  const normalized = agentType?.trim().toLowerCase()
  if (!normalized || normalized === 'unknown') {
    return 'other'
  }
  if (normalized === 'claude') {
    return 'claude-code'
  }
  return AGENT_PROMPT_SENT_AGENT_KINDS.has(normalized as AgentKind)
    ? (normalized as AgentKind)
    : 'other'
}

function equivalentInterruptAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  const normalizedActual = actual === 'unknown' ? undefined : actual
  const normalizedBaseline = baseline === 'unknown' ? undefined : baseline
  return normalizedActual === normalizedBaseline
}

// Why: validate the durable `${tabId}:${leafUuid}` leaf suffix at write/hydrate so legacy numeric rows fail closed.
export function isValidPaneKey(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null
  )
}

function dropHydratedIdleClaudeSubagents(
  payload: ParsedAgentStatusPayload
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !payload.subagents?.some((subagent) => subagent.state === 'idle')
  ) {
    return payload
  }
  const activeSubagents = payload.subagents.filter((subagent) => subagent.state !== 'idle')
  // Why: an idle teammate's liveness can't be proven across a restart (its TeammateIdle confirmation is in-memory); prune so a dead pile can't resurrect — a live teammate re-earns its row via SubagentStart.
  return {
    ...payload,
    subagents: activeSubagents.length > 0 ? activeSubagents : undefined
  }
}

// Why: the sole gate for keeping a providerSessionOnly row; shared so hydrate and relay-ingest can't drift.
function isValidPiProviderSessionOnly(
  providerSession: AgentProviderSessionMetadata | undefined,
  agentType: AgentType | undefined
): boolean {
  return Boolean(providerSession && agentType === 'pi' && getAgentResumeArgv('pi', providerSession))
}

function sanitizeHydratedEntry(
  paneKey: string,
  rawEntry: unknown
): EnrichedAgentHookEventPayload | null {
  const parsedPaneKey = parsePaneKey(paneKey)
  if (!parsedPaneKey) {
    return null
  }
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  if (record.paneKey !== paneKey) {
    return null
  }
  const tabId = record.tabId
  if (tabId !== undefined && (typeof tabId !== 'string' || tabId.length === 0)) {
    return null
  }
  // Why: a stored tabId that diverges from the paneKey's tab segment is corruption; drop instead of hydrating an inconsistent row.
  if (typeof tabId === 'string' && tabId !== parsedPaneKey.tabId) {
    return null
  }
  const worktreeId = record.worktreeId
  if (worktreeId !== undefined && (typeof worktreeId !== 'string' || worktreeId.length === 0)) {
    return null
  }
  const receivedAt = record.receivedAt
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) {
    return null
  }
  const stateStartedAt = record.stateStartedAt
  if (
    typeof stateStartedAt !== 'number' ||
    !Number.isFinite(stateStartedAt) ||
    stateStartedAt <= 0
  ) {
    return null
  }
  // Why: connectionId is null (local) or string (relay); any other shape is rejected to keep the typed surface honest.
  const connectionIdRaw = record.connectionId
  let connectionId: string | null
  if (connectionIdRaw === null || connectionIdRaw === undefined) {
    connectionId = null
  } else if (typeof connectionIdRaw === 'string') {
    connectionId = connectionIdRaw
  } else {
    return null
  }
  const payload = normalizeAgentStatusPayload(record.payload)
  if (!payload) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(record.providerSession) ?? undefined
  const providerSessionOnly = record.providerSessionOnly === true
  if (providerSessionOnly && !isValidPiProviderSessionOnly(providerSession, payload.agentType)) {
    return null
  }
  return {
    paneKey,
    tabId: typeof tabId === 'string' ? tabId : undefined,
    worktreeId: typeof worktreeId === 'string' ? worktreeId : undefined,
    connectionId,
    hasExplicitPrompt: record.hasExplicitPrompt === true ? true : undefined,
    hookEventName: typeof record.hookEventName === 'string' ? record.hookEventName : undefined,
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    toolAgentId: typeof record.toolAgentId === 'string' ? record.toolAgentId : undefined,
    toolAgentType: typeof record.toolAgentType === 'string' ? record.toolAgentType : undefined,
    providerSession,
    providerSessionOnly: providerSessionOnly ? true : undefined,
    payload,
    receivedAt,
    stateStartedAt
  }
}

function readPersistedLaunchTokenHash(rawEntry: unknown): string | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  if (/^[a-f0-9]{64}$/.test(launchTokenHash)) {
    return launchTokenHash
  }
  const legacyLaunchToken = typeof record.launchToken === 'string' ? record.launchToken.trim() : ''
  return legacyLaunchToken ? createHash('sha256').update(legacyLaunchToken).digest('hex') : null
}

function sanitizePersistedAuthorityCommitment(
  paneKey: string,
  value: unknown
): AgentHookAuthorityEvidence | null {
  if (!isValidPaneKey(paneKey) || typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  const connectionId = record.connectionId
  const observedAt = record.observedAt
  if (
    !/^[a-f0-9]{64}$/.test(launchTokenHash) ||
    (connectionId !== null && typeof connectionId !== 'string') ||
    typeof observedAt !== 'number' ||
    !Number.isFinite(observedAt)
  ) {
    return null
  }
  return Object.freeze({
    paneKey,
    launchTokenHash,
    connectionId,
    ...(typeof record.tabId === 'string' ? { tabId: record.tabId } : {}),
    ...(typeof record.worktreeId === 'string' ? { worktreeId: record.worktreeId } : {}),
    observedAt
  })
}

function authorityCommitmentsMatch(
  left: AgentHookAuthorityEvidence,
  right: AgentHookAuthorityEvidence
): boolean {
  return (
    left.paneKey === right.paneKey &&
    left.launchTokenHash === right.launchTokenHash &&
    left.connectionId === right.connectionId &&
    left.tabId === right.tabId &&
    left.worktreeId === right.worktreeId
  )
}

function toAgentStatusIpcPayload(entry: EnrichedAgentHookEventPayload): AgentStatusIpcPayload {
  return {
    paneKey: entry.paneKey,
    ...(entry.launchToken ? { launchToken: entry.launchToken } : {}),
    tabId: entry.tabId,
    worktreeId: entry.worktreeId,
    connectionId: entry.connectionId,
    receivedAt: entry.receivedAt,
    stateStartedAt: entry.stateStartedAt,
    ...(entry.providerSession ? { providerSession: entry.providerSession } : {}),
    ...(entry.providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(entry.promptInteractionKey ? { promptInteractionKey: entry.promptInteractionKey } : {}),
    ...entry.payload
  }
}

// Why: OSC never carries model/children; omit both so an equivalent OSC ping preserves the hook-cached identity graph.
function equivalentParsedAgentStatusPayload(
  a: ParsedAgentStatusPayload,
  b: ParsedAgentStatusPayload
): boolean {
  return (
    a.state === b.state &&
    a.prompt === b.prompt &&
    a.agentType === b.agentType &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.interactivePrompt === b.interactivePrompt &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.interrupted === b.interrupted
  )
}

function trackEmptyPaneKeyHook(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return
  }
  const paneKey = (body as Record<string, unknown>).paneKey
  if (typeof paneKey === 'string' && paneKey.trim().length > 0) {
    return
  }
  track('agent_hook_unattributed', { reason: 'empty_pane_key' })
}

function isToolProgressWorkingAfterInterrupt(next: AgentHookEventPayload): boolean {
  if (next.payload.state !== 'working') {
    return false
  }
  if (next.payload.agentType !== 'claude') {
    return false
  }
  // Why: a same-prompt retry is another UserPromptSubmit, while late post-Ctrl+C progress arrives as tool lifecycle work.
  return next.hookEventName !== undefined && TOOL_PROGRESS_HOOK_EVENTS.has(next.hookEventName)
}

function paneCacheKeyTabId(key: string): string | null {
  const paneKey = key.split('\0', 1)[0] ?? key
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

function paneCacheKeyMatchesTab(key: string, tabId: string): boolean {
  return paneCacheKeyTabId(key) === tabId
}

function shouldKeepClaudePermissionVisible(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
    previous.hookEventName !== 'PermissionRequest' ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'working'
  ) {
    return false
  }
  if (next.hasExplicitPrompt === true) {
    return false
  }
  if (isClaudePermissionResumingApprovedTool(previous, next)) {
    return false
  }
  // Why: only real permission requests stay sticky; newer Claude reports AskUserQuestion as a PermissionRequest, so tool name (not event) decides.
  if (isAskUserQuestionTool(previous.payload.toolName)) {
    return false
  }
  return true
}

function isClaudePermissionResumingApprovedTool(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const previousToolUseId = previous.toolUseId?.trim() || undefined
  const nextToolUseId = next.toolUseId?.trim() || undefined
  const previousAgentId = previous.toolAgentId?.trim() || undefined
  const nextAgentId = next.toolAgentId?.trim() || undefined
  const hasAgentId = previousAgentId !== undefined || nextAgentId !== undefined
  const previousAgentType = previous.toolAgentType?.trim() || undefined
  const nextAgentType = next.toolAgentType?.trim() || undefined
  const hasMatchingConcreteAgentId =
    previousAgentId !== undefined && previousAgentId === nextAgentId
  const hasSameExplicitAgentType =
    !hasAgentId && previousAgentType !== undefined && previousAgentType === nextAgentType
  const sameToolName =
    previous.payload.toolName !== undefined && previous.payload.toolName === next.payload.toolName
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownInputFromConcreteAgent =
    hasMatchingConcreteAgentId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined
  const hasMatchingToolUseId =
    previousToolUseId !== undefined && previousToolUseId === nextToolUseId
  const hasConflictingToolUseId =
    previousToolUseId !== undefined &&
    nextToolUseId !== undefined &&
    previousToolUseId !== nextToolUseId
  const sameUnknownInputFromToolUseId =
    hasMatchingToolUseId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined

  return (
    (next.hookEventName === 'PreToolUse' || next.hookEventName === 'PostToolUse') &&
    nextToolUseId !== undefined &&
    !hasConflictingToolUseId &&
    // Why: subagents share agent_type, so a concrete agent id (or the preserved PostToolUse tool_use_id) is the safest resume signal.
    (hasMatchingConcreteAgentId || hasSameExplicitAgentType || hasMatchingToolUseId) &&
    sameToolName &&
    (sameKnownToolInput || sameUnknownInputFromConcreteAgent || sameUnknownInputFromToolUseId)
  )
}

function shouldInheritClaudeToolUseIdForPermission(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'working' ||
    previous.hookEventName !== 'PreToolUse' ||
    typeof previous.toolUseId !== 'string' ||
    previous.toolUseId.trim().length === 0 ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'waiting' ||
    next.hookEventName !== 'PermissionRequest' ||
    next.toolUseId !== undefined
  ) {
    return false
  }
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownToolInput =
    previous.payload.toolInput === undefined && next.payload.toolInput === undefined
  if (
    previous.toolAgentId !== next.toolAgentId ||
    previous.toolAgentType !== next.toolAgentType ||
    previous.payload.toolName === undefined ||
    previous.payload.toolName !== next.payload.toolName ||
    (!sameKnownToolInput && !sameUnknownToolInput)
  ) {
    return false
  }
  return true
}

function attachClaudePermissionToolUseId(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload {
  const inheritedToolUseId = previous?.toolUseId
  if (
    !shouldInheritClaudeToolUseIdForPermission(previous, next) ||
    typeof inheritedToolUseId !== 'string'
  ) {
    return next
  }
  return {
    ...next,
    // Why: Claude emits PermissionRequest without tool_use_id, then PostToolUse carries the original PreToolUse id.
    toolUseId: inheritedToolUseId
  }
}

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so the server can detect dev vs. prod cross-talk; set at start() from packaged-build knowledge.
  private env = 'production'
  private onAgentStatus: ((payload: EnrichedAgentHookEventPayload) => void) | null = null
  private onClaudeStatusLine: ((event: ClaudeStatusLineRateLimits) => void) | null = null
  private onPaneStatusCleared: PaneStatusClearListener | null = null
  private statusChangeListeners = new Set<StatusChangeListener>()
  private providerSessionChangeListeners = new Set<ProviderSessionChangeListener>()
  // Why: setListener is a single slot owned by the main-window fanout; the
  // plugin event bus (and future consumers) need an additive subscription
  // that also works in headless serve, where no window listener exists.
  private enrichedStatusListeners = new Set<(payload: EnrichedAgentHookEventPayload) => void>()
  // Why: set via start()'s userDataPath so the class has no direct Electron dependency (mockable in vitest node env).
  private endpointDir: string | null = null
  private endpointFilePathCache: string | null = null
  private endpointFileWritten = false
  // Why: per-instance (not module-level) so tests can spin up multiple servers without state cross-contamination.
  private state: HookListenerState = createHookListenerState()
  // Why: hydrated rows give UI continuity but aren't evidence of live agent work in this runtime.
  private runtimeObservedStatusPaneKeys = new Set<string>()
  private hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  private hydratedLaunchTokenHashByPaneKey = new Map<string, string>()
  private persistedAuthorityCommitmentsByPaneKey = new Map<string, AgentHookAuthorityEvidence>()
  private revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  private currentAuthorityObservations = new Map<string, AgentHookAuthorityEvidence>()
  private legacyPaneKeyAliases = new Map<string, PaneKeyAliasEntry>()
  private paneKeyAliasPersistenceListener: PaneKeyAliasPersistenceListener | null = null
  // Why: on-disk last-status cache path; null without a userDataPath (tests), where persistence is a no-op and only in-memory replay applies.
  private lastStatusFilePath: string | null = null
  // Why: trailing-edge debounce timer, per-instance so test servers in one process don't share state.
  private statusPersistTimer: ReturnType<typeof setTimeout> | null = null
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private codexSubagentPollTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private promptSentDedupeByPaneKey = new Map<string, AgentPromptSentDedupeEntry>()
  private promptSentHashSalt = randomBytes(16).toString('hex')
  private closedAgentStatusTabIds = new Set<string>()
  private closedAgentStatusPaneKeys = new Set<string>()
  private connectionTimestampWatermarkById = new Map<string, number>()
  // Why: skip disk writes when the JSON exactly matches the last write; guards against re-firing trailing timers when nothing changed.
  private lastWrittenJson: string | null = null

  setListener(listener: ((payload: EnrichedAgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener can't starve the rest.
    for (const payload of this.state.lastStatusByPaneKey.values()) {
      try {
        // Why: cache always holds enriched payloads; the map's declared type is the bare shape only because the shared module never reads it.
        listener({ ...(payload as EnrichedAgentHookEventPayload), isReplay: true })
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  // Why: statusline posts carry live Claude usage windows, not agent status; they feed RateLimitService directly.
  setClaudeStatusLineListener(
    listener: ((event: ClaudeStatusLineRateLimits) => void) | null
  ): void {
    this.onClaudeStatusLine = listener
  }

  subscribeStatusChanges(listener: StatusChangeListener): () => void {
    this.statusChangeListeners.add(listener)
    return () => {
      this.statusChangeListeners.delete(listener)
    }
  }

  subscribeProviderSessionChanges(listener: ProviderSessionChangeListener): () => void {
    this.providerSessionChangeListeners.add(listener)
    return () => {
      this.providerSessionChangeListeners.delete(listener)
    }
  }

  /** Multi-subscriber tap on every enriched status change (no replay). */
  subscribeEnrichedStatus(listener: (payload: EnrichedAgentHookEventPayload) => void): () => void {
    this.enrichedStatusListeners.add(listener)
    return () => {
      this.enrichedStatusListeners.delete(listener)
    }
  }

  setPaneStatusClearListener(listener: PaneStatusClearListener | null): void {
    this.onPaneStatusCleared = listener
  }

  /** Snapshot of cached statuses in IPC shape. Used by `agentStatus:getSnapshot` after tabs hydrate so the
   *  dashboard catches up on hook events that fired during startup. */
  getStatusSnapshot(): AgentStatusIpcPayload[] {
    return Array.from(this.state.lastStatusByPaneKey.values(), (entry) =>
      toAgentStatusIpcPayload(entry as EnrichedAgentHookEventPayload)
    )
  }

  /** Provider-session identities, including Pi's metadata-only rows. */
  getProviderSessionIdentities(): AgentHookProviderSessionIdentity[] {
    return this.buildStatusChangeNotification().providerSessions
  }

  getStatusSnapshotForPane(paneKey: string): AgentStatusIpcPayload[] {
    const entry = this.state.lastStatusByPaneKey.get(paneKey)
    return entry ? [toAgentStatusIpcPayload(entry as EnrichedAgentHookEventPayload)] : []
  }

  getHydratedAuthorityCommitments(): readonly AgentHookAuthorityEvidence[] {
    return this.hydratedAuthorityCommitments
  }

  getCurrentAuthorityObservations(): readonly AgentHookAuthorityEvidence[] {
    return Object.freeze(
      Array.from(this.currentAuthorityObservations.values(), (entry) => Object.freeze({ ...entry }))
    )
  }

  attestCompatibilityAuthority(candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    terminalProvenance: 'current_runtime' | 'restored'
  }): AgentHookAuthorityAttestation | null {
    const paneKey = this.resolvePaneKeyAlias(candidate.paneKey)
    const matchesCandidate = (entry: AgentHookAuthorityEvidence): boolean =>
      entry.launchTokenHash === candidate.launchTokenHash &&
      entry.connectionId === candidate.connectionId
    const commitments = this.hydratedAuthorityCommitments.filter(
      (entry) => matchesCandidate(entry) && !this.revokedHydratedAuthorityCommitments.has(entry)
    )
    const current = Array.from(this.currentAuthorityObservations.values())
    const observations = current.filter(matchesCandidate)
    const paneObservations = current.filter(
      (entry) => this.resolvePaneKeyAlias(entry.paneKey) === paneKey
    )
    const hasUniqueCurrentObservation =
      observations.length === 1 &&
      paneObservations.length === 1 &&
      this.resolvePaneKeyAlias(observations[0]!.paneKey) === paneKey
    if (candidate.terminalProvenance === 'current_runtime') {
      return hasUniqueCurrentObservation ? Object.freeze({ paneKey, source: 'current_hook' }) : null
    }
    if (commitments.length !== 1 || this.resolvePaneKeyAlias(commitments[0]!.paneKey) !== paneKey) {
      return null
    }
    if (observations.length === 0 && paneObservations.length === 0) {
      return Object.freeze({ paneKey, source: 'hydrated_commitment' })
    }
    if (!hasUniqueCurrentObservation) {
      return null
    }
    return Object.freeze({ paneKey, source: 'current_hook' })
  }

  inferInterrupt(request: AgentInterruptInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    if (!isAgentInterruptInputIntent(request.intent)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    if (existing.providerSessionOnly) {
      return false
    }
    const payload = existing.payload
    const agentType: AgentType | undefined = payload.agentType
    // Why: Droid's Ctrl+C exits the CLI (handled by PTY lifecycle) rather than interrupting the current turn.
    if (agentType === 'droid' && request.intent === 'ctrl-c') {
      return false
    }
    // Why: these agents use the first Escape as a TUI cancel that can leave the turn running; only a double Escape infers an interrupt.
    if (
      (agentType === 'opencode' || agentType === 'copilot') &&
      request.intent === 'plain-escape' &&
      request.inputCount !== 2
    ) {
      return false
    }
    // Why: inference is a fallback for a missing final hook; a strict baseline match keeps a delayed timer from clobbering any newer hook.
    if (
      payload.state !== 'working' ||
      !equivalentInterruptAgentType(agentType, request.baselineAgentType) ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Why: a 'working' pane can be child-driven; Ctrl+C doesn't stop background children, so inferring done would retire live child rows.
    if (payload.subagents?.some((subagent) => subagent.state !== 'idle')) {
      return false
    }

    // Why: keep the Claude lead-turn record in sync, or a later child event re-emits the stale 'working' state and resurrects the cancelled pane.
    if (agentType === 'claude') {
      markClaudeLeadTurnInterrupted(this.state, existing.paneKey)
    }
    if (agentType === 'codex') {
      markCodexLeadTurnInterrupted(this.state, existing.paneKey)
    }
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      payload: {
        state: 'done',
        prompt: payload.prompt,
        agentType,
        ...(payload.model ? { model: payload.model } : {}),
        interrupted: true,
        // Why: idle children are display state; dropping them on an inferred interrupt blanks rows a later hook would restore.
        ...(payload.subagents ? { subagents: payload.subagents } : {})
      }
    })
    console.debug('[agent-hooks] inferred interrupted agent status', {
      paneKey: inferred.paneKey,
      agentType,
      intent: request.intent
    })
    return true
  }

  /** Guarded fallback for a hook Claude never sends: answering AskUserQuestion produces no event, so re-validate the
   *  renderer's baseline against the cached status (a racing real hook wins) and synthesize the post-answer state. */
  inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    const payload = existing.payload
    // Why: only Claude's interactive question clears on typed input — tool name (not hook event) discriminates; real permission waits stay sticky.
    if (
      payload.agentType !== 'claude' ||
      payload.state !== 'waiting' ||
      !isAskUserQuestionTool(payload.toolName)
    ) {
      return false
    }
    if (
      payload.agentType !== request.baselineAgentType ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Why: sync the listener's lead-turn record too, or a later child event re-emits the stale waiting state and resurrects the card.
    const restored = clearClaudeAnsweredQuestionWait(this.state, existing.paneKey)
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      payload: {
        state: restored.state,
        prompt: payload.prompt,
        agentType: payload.agentType,
        ...(restored.state === 'done' && restored.interrupted ? { interrupted: true } : {}),
        ...(payload.subagents ? { subagents: payload.subagents } : {})
      }
    })
    console.debug('[agent-hooks] inferred answered question status', {
      paneKey: inferred.paneKey,
      state: inferred.payload.state
    })
    return true
  }

  getStatusChangeSnapshot(): AgentHookStatusChangeEntry[] {
    return this.buildStatusChangeNotification().statuses
  }

  private buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  } {
    const statuses: AgentHookStatusChangeEntry[] = []
    const providerSessions: AgentHookProviderSessionIdentity[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (enriched.providerSession) {
        providerSessions.push({
          paneKey,
          sessionId: enriched.providerSession.id,
          ...(enriched.providerSession.transcriptPath
            ? { transcriptPath: enriched.providerSession.transcriptPath }
            : {}),
          ...(enriched.worktreeId ? { worktreeId: enriched.worktreeId } : {})
        })
      }
      if (!enriched.providerSessionOnly) {
        statuses.push({
          state: enriched.payload.state,
          receivedAt: enriched.receivedAt,
          observedInCurrentRuntime: this.runtimeObservedStatusPaneKeys.has(paneKey)
        })
      }
    }
    return { statuses, providerSessions }
  }

  private notifyStatusChangeListeners(): void {
    if (this.statusChangeListeners.size === 0 && this.providerSessionChangeListeners.size === 0) {
      return
    }
    const { statuses, providerSessions } = this.buildStatusChangeNotification()
    for (const listener of this.statusChangeListeners) {
      try {
        listener(statuses)
      } catch (err) {
        console.error('[agent-hooks] status-change listener threw', err)
      }
    }
    for (const listener of this.providerSessionChangeListeners) {
      try {
        listener(providerSessions)
      } catch (err) {
        console.error('[agent-hooks] provider-session listener threw', err)
      }
    }
  }

  private markTabClosedForAgentStatus(tabId: string): void {
    // Delete-then-add keeps recently closed tabs most-recent so eviction sheds only the oldest ids.
    this.closedAgentStatusTabIds.delete(tabId)
    this.closedAgentStatusTabIds.add(tabId)
    while (this.closedAgentStatusTabIds.size > CLOSED_AGENT_STATUS_TAB_IDS_MAX) {
      const oldest = this.closedAgentStatusTabIds.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.closedAgentStatusTabIds.delete(oldest)
    }
  }

  private shouldSuppressClosedTabStatus(paneKey: string): boolean {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    if (
      this.closedAgentStatusPaneKeys.has(paneKey) ||
      this.closedAgentStatusPaneKeys.has(ownerPaneKey)
    ) {
      return true
    }
    const tabId = parsePaneKey(ownerPaneKey)?.tabId
    if (!tabId) {
      return false
    }
    return this.closedAgentStatusTabIds.has(tabId)
  }

  private markPaneClosedForAgentStatus(paneKey: string): void {
    this.closedAgentStatusPaneKeys.delete(paneKey)
    this.closedAgentStatusPaneKeys.add(paneKey)
    while (this.closedAgentStatusPaneKeys.size > CLOSED_AGENT_STATUS_PANE_KEYS_MAX) {
      const oldest = this.closedAgentStatusPaneKeys.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.closedAgentStatusPaneKeys.delete(oldest)
    }
  }

  private attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now()
  ): EnrichedAgentHookEventPayload {
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const commandCodeNewTurn =
      previous !== undefined &&
      isCommandCodeNewTurnWhileWorking({
        agentType: payload.payload.agentType,
        previousState: previous.payload.state,
        incomingState: payload.payload.state,
        previousPrompt: previous.payload.prompt,
        incomingPrompt: payload.payload.prompt,
        hasExplicitPrompt: payload.hasExplicitPrompt,
        previousPromptInteractionKey: previous.promptInteractionKey,
        incomingPromptInteractionKey: payload.promptInteractionKey
      })
    const stateStartedAt =
      previous && previous.payload.state === payload.payload.state && !commandCodeNewTurn
        ? previous.stateStartedAt
        : now
    return {
      ...payload,
      receivedAt: now,
      stateStartedAt
    }
  }

  private hashPromptForTelemetryDedupe(prompt: string): string {
    return createHash('sha256')
      .update(this.promptSentHashSalt)
      .update('\0')
      .update(prompt)
      .digest('hex')
  }

  private maybeTrackAgentPromptSent(
    payload: AgentHookEventPayload,
    previousStatus: EnrichedAgentHookEventPayload | undefined
  ): void {
    if (payload.isReplay === true || payload.hasExplicitPrompt !== true) {
      return
    }
    const prompt = payload.payload.prompt?.trim() ?? ''
    if (prompt.length === 0) {
      return
    }
    const agentKind = agentTypeToPromptSentAgentKind(payload.payload.agentType)
    const promptHash = this.hashPromptForTelemetryDedupe(prompt)
    const promptInteractionKey =
      typeof payload.promptInteractionKey === 'string' &&
      payload.promptInteractionKey.trim().length > 0
        ? payload.promptInteractionKey.trim()
        : undefined
    const previousDedupe = this.promptSentDedupeByPaneKey.get(payload.paneKey)
    const isCompletedTurnBoundary =
      previousStatus?.payload.state === 'done' && payload.payload.state === 'working'
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptInteractionKey !== undefined &&
      previousDedupe.promptInteractionKey === promptInteractionKey &&
      (agentKind === 'opencode' || previousDedupe.promptHash === promptHash)
    ) {
      return
    }
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptHash === promptHash &&
      !(
        previousStatus?.payload.state === 'done' &&
        payload.payload.state === 'done' &&
        previousDedupe.promptInteractionKey !== undefined &&
        promptInteractionKey !== undefined &&
        previousDedupe.promptInteractionKey !== promptInteractionKey
      ) &&
      !isCompletedTurnBoundary
    ) {
      return
    }
    this.promptSentDedupeByPaneKey.set(payload.paneKey, {
      agentKind,
      promptHash,
      promptInteractionKey
    })
    try {
      // Why: hooks prove a turn was submitted but not which UI launched the terminal; keep attribution low-cardinality.
      track('agent_prompt_sent', {
        agent_kind: agentKind,
        launch_source: 'unknown',
        request_kind: 'followup',
        ...getCohortAtEmit()
      })
    } catch (err) {
      console.error('[agent-hooks] prompt-sent telemetry failed', err)
    }
  }

  private applyNormalizedStatus(payload: AgentHookEventPayload): EnrichedAgentHookEventPayload {
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const connectionClearWatermark = payload.connectionId
      ? this.connectionTimestampWatermarkById.get(payload.connectionId)
      : undefined
    // Why: Date.now() can repeat across reconnect; a remote replay must sort strictly after its connection's transient clear.
    const now = Math.max(Date.now(), (connectionClearWatermark ?? -1) + 1)
    if (payload.connectionId) {
      this.connectionTimestampWatermarkById.set(payload.connectionId, now)
    }
    if (payload.providerSessionOnly) {
      // Why: Pi session_start replaces stale turn state and survives replay, but must not emit prompt telemetry or a fabricated status.
      const enriched = this.attachStatusTiming(payload, now)
      this.clearAssistantMessageRetry(enriched.paneKey)
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
      this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload =
      payload.connectionId && payload.payload.agentType === 'codex' && payload.hookEventName
        ? {
            ...payload,
            payload: reconcileRemoteCodexState(
              this.state,
              payload.paneKey,
              payload.hookEventName,
              payload.toolAgentId,
              payload.payload,
              previous?.payload
            )
          }
        : payload
    const previousCodexRoot =
      stateReconciledPayload.payload.agentType === 'codex' &&
      stateReconciledPayload.toolAgentId &&
      previous?.payload.agentType === 'codex'
        ? previous
        : undefined
    const preservedProviderSession = !stateReconciledPayload.providerSession
      ? previousCodexRoot?.providerSession
      : undefined
    const preservedRootModel = !stateReconciledPayload.payload.model
      ? previousCodexRoot?.payload.model
      : undefined
    // Why: an SSH relay restart forgets root-only fields; child hooks must not erase durable resume/model identity.
    const rootContextPreservingPayload =
      preservedProviderSession || preservedRootModel
        ? {
            ...stateReconciledPayload,
            ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
            payload: preservedRootModel
              ? { ...stateReconciledPayload.payload, model: preservedRootModel }
              : stateReconciledPayload.payload
          }
        : stateReconciledPayload
    const identity = resolveAgentStatusIdentity({
      existing: previous
        ? {
            agentType: previous.payload.agentType,
            state: previous.payload.state,
            updatedAt: previous.receivedAt
          }
        : undefined,
      incoming: rootContextPreservingPayload.payload.agentType,
      now
    })
    if (
      previous &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: rootContextPreservingPayload.payload.state
      })
    ) {
      return previous
    }
    const identityResolvedPayload =
      identity.agentType === rootContextPreservingPayload.payload.agentType
        ? rootContextPreservingPayload
        : {
            ...rootContextPreservingPayload,
            payload: {
              ...rootContextPreservingPayload.payload,
              agentType: identity.agentType
            }
          }
    const effectivePayload = attachClaudePermissionToolUseId(previous, identityResolvedPayload)
    if (previous && shouldKeepClaudePermissionVisible(previous, effectivePayload)) {
      return previous
    }
    // Why: some TUIs emit a delayed tool/working hook after Ctrl+C stopped the turn; don't let it resurrect the row.
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'done' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
    ) {
      return previous
    }
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'working' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      (effectivePayload.isReplay === true ||
        isToolProgressWorkingAfterInterrupt(effectivePayload) ||
        (effectivePayload.hasExplicitPrompt !== true &&
          Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS))
    ) {
      return previous
    }
    if (
      effectivePayload.payload.state !== 'done' ||
      effectivePayload.payload.lastAssistantMessage
    ) {
      this.clearAssistantMessageRetry(effectivePayload.paneKey)
    }
    if (!identity.inheritedFromActivePane) {
      this.maybeTrackAgentPromptSent(effectivePayload, previous)
    }
    const enriched = this.attachStatusTiming(effectivePayload, now)
    this.runtimeObservedStatusPaneKeys.add(enriched.paneKey)
    this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(enriched)
    return enriched
  }

  // Why: every status emit must reach plugins too, so a new early-return path
  // upstream cannot silently leave the plugin tap behind the main-window fanout.
  private emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void {
    this.onAgentStatus?.(enriched)
    for (const listener of this.enrichedStatusListeners) {
      try {
        listener(enriched)
      } catch (err) {
        console.error('[agent-hooks] enriched status listener threw', err)
      }
    }
  }

  private clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  private clearCodexSubagentPoll(paneKey: string): void {
    const timer = this.codexSubagentPollTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.codexSubagentPollTimers.delete(paneKey)
  }

  private scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    // Why: a nested non-codex CLI inherits ORCA_PANE_KEY, so clearing here would silently end a live codex poll.
    if (source !== 'codex') {
      return
    }
    this.clearCodexSubagentPoll(original.paneKey)
    if (!hasCodexTranscriptSubagents(this.state, original.paneKey)) {
      return
    }
    const timer = setTimeout(() => {
      this.codexSubagentPollTimers.delete(original.paneKey)
      const current = this.state.lastStatusByPaneKey.get(original.paneKey)
      if (!this.server || current !== original) {
        return
      }
      const normalized = normalizeHookPayload(this.state, source, body, this.env)
      if (!normalized) {
        return
      }
      const subagentsChanged =
        JSON.stringify(normalized.payload.subagents) !== JSON.stringify(original.payload.subagents)
      const next = subagentsChanged ? this.applyNormalizedStatus(normalized) : original
      this.scheduleCodexSubagentPoll(source, body, next)
    }, CODEX_SUBAGENT_POLL_MS)
    this.codexSubagentPollTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Why: slug-group discovery can outlive the bounded flush timers; its completion must drive the first retry deterministically.
        void discovery
          .then(() => {
            if (this.server) {
              this.applyAssistantMessageRetry(source, body, original, 1, true)
            }
          })
          .catch((err) => {
            console.error('[agent-hooks] Grok result discovery failed:', err)
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(source, body, original, attempt + 1, discoveryReady)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.state.lastStatusByPaneKey.get(original.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const normalized = normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(source, body, original, nextAttempt, requireExactOriginal)
      return
    }
    // Why: some agents POST Stop before their transcript line is flushed; discovery is event-driven, later content retries stay timed.
    this.applyNormalizedStatus(normalized)
  }

  setPaneKeyAliasPersistenceListener(listener: PaneKeyAliasPersistenceListener | null): void {
    this.paneKeyAliasPersistenceListener = listener
  }

  private getPersistedPaneKeyAliases(): LegacyPaneKeyAliasEntry[] {
    return Array.from(this.legacyPaneKeyAliases.entries()).flatMap(([legacyPaneKey, entry]) =>
      entry.ptyId
        ? [
            {
              ptyId: entry.ptyId,
              legacyPaneKey,
              stablePaneKey: entry.stablePaneKey,
              updatedAt: entry.updatedAt
            }
          ]
        : []
    )
  }

  private notifyPaneKeyAliasPersistenceListener(): void {
    this.paneKeyAliasPersistenceListener?.(this.getPersistedPaneKeyAliases())
  }

  private boundPaneKeyAliases(): void {
    while (this.legacyPaneKeyAliases.size > PANE_KEY_ALIASES_MAX) {
      // Why: renderer-originated aliases are untrusted; insertion-order eviction bounds memory and per-message cleanup.
      const oldestKey = this.legacyPaneKeyAliases.keys().next().value
      if (!oldestKey) {
        break
      }
      this.legacyPaneKeyAliases.delete(oldestKey)
    }
  }

  private getPhysicalPaneKeyForAuthority(paneKey: string, ptyId?: string): string {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    let fallbackPaneKey = paneKey
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (
        entry.stablePaneKey === ownerPaneKey &&
        (!ptyId || !entry.ptyId || entry.ptyId === ptyId)
      ) {
        if (entry.authorityVerified) {
          return physicalPaneKey
        }
        fallbackPaneKey = physicalPaneKey
      }
    }
    return fallbackPaneKey
  }

  canTransferPaneAuthority(
    fromPaneKey: string,
    ptyId: string | undefined,
    ownsPty: (physicalPaneKey: string, ptyId: string) => boolean
  ): boolean {
    if (!isValidPaneKey(fromPaneKey)) {
      return false
    }
    const ownerPaneKey = this.resolvePaneKeyAlias(fromPaneKey)
    const physicalPaneKey = this.getPhysicalPaneKeyForAuthority(fromPaneKey, ptyId)
    const alias = this.legacyPaneKeyAliases.get(physicalPaneKey)
    if (ptyId) {
      return Boolean(
        (alias?.authorityVerified && alias.ptyId === ptyId) ||
        ownsPty(physicalPaneKey, ptyId) ||
        (ownerPaneKey !== physicalPaneKey && ownsPty(ownerPaneKey, ptyId))
      )
    }
    // Why: hook status is renderer evidence, not PTY ownership; ID-less moves are safe only after a verified transfer minted an alias.
    return alias?.authorityVerified === true
  }

  registerPaneKeyAlias(
    legacyPaneKey: string,
    stablePaneKey: string,
    ptyId?: string,
    updatedAt = Date.now(),
    options?: { overwriteExisting?: boolean; authorityVerified?: boolean }
  ): void {
    const legacy = parseLegacyNumericPaneKey(legacyPaneKey)
    const stable = isValidPaneKey(stablePaneKey) ? parsePaneKey(stablePaneKey) : null
    if (!legacy || !stable || legacy.tabId !== stable.tabId) {
      return
    }
    const existing = this.legacyPaneKeyAliases.get(legacy.paneKey)
    if (existing && options?.overwriteExisting === false) {
      return
    }
    const normalizedPtyId =
      typeof ptyId === 'string' && ptyId.trim().length > 0 ? ptyId.trim() : existing?.ptyId
    const normalizedUpdatedAt =
      Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : (existing?.updatedAt ?? Date.now())
    const authorityVerified = options?.authorityVerified ?? false
    if (
      existing &&
      existing.stablePaneKey === stablePaneKey &&
      existing.ptyId === (normalizedPtyId ?? null) &&
      existing.updatedAt === normalizedUpdatedAt &&
      existing.authorityVerified === authorityVerified
    ) {
      return
    }
    this.legacyPaneKeyAliases.set(legacy.paneKey, {
      stablePaneKey,
      ptyId: normalizedPtyId ?? null,
      updatedAt: normalizedUpdatedAt,
      authorityVerified
    })
    this.boundPaneKeyAliases()
    if (normalizedPtyId) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
  }

  transferPaneAuthority(
    fromPaneKey: string,
    toPaneKey: string,
    ptyId?: string,
    updatedAt = Date.now(),
    options?: { authorityVerified?: boolean }
  ): void {
    if (!isValidPaneKey(fromPaneKey) || !isValidPaneKey(toPaneKey)) {
      return
    }
    const previousOwnerPaneKey = this.resolvePaneKeyAlias(fromPaneKey)
    const physicalPaneKey = this.getPhysicalPaneKeyForAuthority(fromPaneKey, ptyId)
    const existing = this.legacyPaneKeyAliases.get(physicalPaneKey)
    const normalizedPtyId = ptyId?.trim() || existing?.ptyId || null
    const hadStatus = this.state.lastStatusByPaneKey.has(previousOwnerPaneKey)
    movePaneCacheState(this.state, previousOwnerPaneKey, toPaneKey)
    const movedStatus = this.state.lastStatusByPaneKey.get(toPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (movedStatus) {
      const owner = parsePaneKey(toPaneKey)
      this.state.lastStatusByPaneKey.set(toPaneKey, {
        ...movedStatus,
        paneKey: toPaneKey,
        tabId: owner?.tabId
      })
    }
    const hydratedLaunchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(previousOwnerPaneKey)
    if (hydratedLaunchTokenHash) {
      this.hydratedLaunchTokenHashByPaneKey.delete(previousOwnerPaneKey)
      this.hydratedLaunchTokenHashByPaneKey.set(toPaneKey, hydratedLaunchTokenHash)
    }
    const persistedAuthority = this.persistedAuthorityCommitmentsByPaneKey.get(previousOwnerPaneKey)
    if (persistedAuthority) {
      const owner = parsePaneKey(toPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(previousOwnerPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.set(
        toPaneKey,
        Object.freeze({
          ...persistedAuthority,
          paneKey: toPaneKey,
          ...(owner?.tabId ? { tabId: owner.tabId } : {})
        })
      )
    }
    if (this.runtimeObservedStatusPaneKeys.delete(previousOwnerPaneKey)) {
      this.runtimeObservedStatusPaneKeys.add(toPaneKey)
    }
    const authorityObservation = this.currentAuthorityObservations.get(previousOwnerPaneKey)
    if (authorityObservation) {
      const owner = parsePaneKey(toPaneKey)
      this.currentAuthorityObservations.delete(previousOwnerPaneKey)
      this.currentAuthorityObservations.set(
        toPaneKey,
        Object.freeze({
          ...authorityObservation,
          paneKey: toPaneKey,
          tabId: owner?.tabId
        })
      )
    }
    const promptDedupe = this.promptSentDedupeByPaneKey.get(previousOwnerPaneKey)
    if (promptDedupe !== undefined) {
      this.promptSentDedupeByPaneKey.delete(previousOwnerPaneKey)
      this.promptSentDedupeByPaneKey.set(toPaneKey, promptDedupe)
    }
    this.clearAssistantMessageRetry(previousOwnerPaneKey)
    this.clearCodexSubagentPoll(previousOwnerPaneKey)
    // Why: the live process keeps posting the physical source key after detach; persist a chain-safe mapping to the current owner.
    this.legacyPaneKeyAliases.set(physicalPaneKey, {
      stablePaneKey: toPaneKey,
      ptyId: normalizedPtyId,
      updatedAt,
      authorityVerified: options?.authorityVerified ?? true
    })
    this.boundPaneKeyAliases()
    this.closedAgentStatusPaneKeys.delete(toPaneKey)
    this.notifyPaneKeyAliasPersistenceListener()
    if (hadStatus || persistedAuthority) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  retirePaneAuthority(paneKey: string): void {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, ownerPaneKey])
    let aliasChanged = false
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (physicalPaneKey === paneKey || entry.stablePaneKey === ownerPaneKey) {
        this.legacyPaneKeyAliases.delete(physicalPaneKey)
        paneKeys.add(physicalPaneKey)
        paneKeys.add(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    const hadStatus = [...paneKeys].some((key) => this.state.lastStatusByPaneKey.has(key))
    for (const key of paneKeys) {
      this.markPaneClosedForAgentStatus(key)
      this.clearAssistantMessageRetry(key)
      this.clearCodexSubagentPoll(key)
      clearPaneCacheState(this.state, key)
      this.runtimeObservedStatusPaneKeys.delete(key)
      this.currentAuthorityObservations.delete(key)
      this.promptSentDedupeByPaneKey.delete(key)
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  clearPaneKeyAliasesForPty(
    ptyId: string,
    options?: { shouldClearStablePaneKey?: (paneKey: string) => boolean }
  ): void {
    let aliasChanged = false
    let statusChanged = false
    const clearedStatusPaneKeys = new Set<string>()
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (entry.ptyId === ptyId) {
        const shouldClearStablePaneKey =
          options?.shouldClearStablePaneKey?.(entry.stablePaneKey) ?? true
        const revokedPaneKeys = new Set([legacyPaneKey])
        if (shouldClearStablePaneKey) {
          revokedPaneKeys.add(entry.stablePaneKey)
        }
        if (this.revokeHydratedAuthorityForPaneKeys(revokedPaneKeys)) {
          statusChanged = true
        }
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.currentAuthorityObservations.delete(legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        if (shouldClearStablePaneKey && this.state.lastStatusByPaneKey.has(entry.stablePaneKey)) {
          statusChanged = true
          clearedStatusPaneKeys.add(entry.stablePaneKey)
        }
        if (shouldClearStablePaneKey) {
          // Why: hydrated rows live under the stable key; if this PTY dies before ptyPaneKey rebuilds, alias cleanup is the only evictor.
          clearPaneCacheState(this.state, entry.stablePaneKey)
          this.runtimeObservedStatusPaneKeys.delete(entry.stablePaneKey)
          this.currentAuthorityObservations.delete(entry.stablePaneKey)
          this.promptSentDedupeByPaneKey.delete(entry.stablePaneKey)
        }
        aliasChanged = true
      }
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (statusChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      for (const paneKey of clearedStatusPaneKeys) {
        this.onPaneStatusCleared?.({ paneKey })
      }
    }
  }

  private resolvePaneKeyAlias(paneKey: string): string {
    return this.legacyPaneKeyAliases.get(paneKey)?.stablePaneKey ?? paneKey
  }

  private revokeHydratedAuthorityForPaneKeys(paneKeys: ReadonlySet<string>): boolean {
    let changed = false
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (
        paneKeys.has(commitment.paneKey) ||
        paneKeys.has(this.resolvePaneKeyAlias(commitment.paneKey))
      ) {
        this.revokedHydratedAuthorityCommitments.add(commitment)
        changed = true
      }
    }
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      changed = this.hydratedLaunchTokenHashByPaneKey.delete(paneKey) || changed
      changed = this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey) || changed
      changed = this.persistedAuthorityCommitmentsByPaneKey.delete(paneKey) || changed
      changed = this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey) || changed
    }
    return changed
  }

  private normalizeHookBodyPaneKeyAlias(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) {
      return body
    }
    const record = body as Record<string, unknown>
    const rawPaneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
    const stablePaneKey = this.legacyPaneKeyAliases.get(rawPaneKey)?.stablePaneKey
    if (!stablePaneKey) {
      return body
    }
    // Why: detached shells keep posting the immutable physical pane key; normalize pane and tab identity to the current owner.
    return { ...record, paneKey: stablePaneKey, tabId: parsePaneKey(stablePaneKey)?.tabId }
  }

  ingestTerminalStatus(event: {
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    payload: ParsedAgentStatusPayload
  }): void {
    const physicalPaneKey = event.paneKey.trim()
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
      return
    }
    const reportedTabId =
      event.tabId !== undefined && event.tabId.trim().length > 0 ? event.tabId.trim() : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    if (this.shouldSuppressClosedTabStatus(paneKey)) {
      return
    }
    const worktreeId =
      event.worktreeId !== undefined && event.worktreeId.trim().length > 0
        ? event.worktreeId.trim()
        : undefined
    const connectionId =
      typeof event.connectionId === 'string' && event.connectionId.trim().length > 0
        ? event.connectionId.trim()
        : null
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      equivalentParsedAgentStatusPayload(previous.payload, event.payload)
    ) {
      return
    }
    // Why: the OSC 9999 wire payload has no providerSession field at all, so an OSC observation is
    // never evidence that the session ended — yet overwriting the row dropped the cached identity.
    // That erased it from persisted rows (lost across restart) and from headless `orca serve`, which
    // serves these rows to mobile directly instead of the renderer store, blanking Chat UI (#10630).
    // A new turn after `done` still starts clean so a reused pane cannot inherit a finished session.
    // Why: mirror resolveAgentStatusIdentity, which treats a literal 'unknown' exactly like an
    // omitted type — an OSC ping that names no agent makes no claim about the pane's identity, so
    // it must not be read as a mismatch and strip the session the renderer would have kept.
    const claimedAgentType =
      event.payload.agentType && event.payload.agentType !== 'unknown'
        ? event.payload.agentType
        : undefined
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' || event.payload.state === 'done')
        ? previous.providerSession
        : undefined
    // Why: OSC status is a runtime observation, not a prompt boundary; keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus({
      paneKey,
      tabId,
      worktreeId,
      connectionId,
      ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
      payload: event.payload
    })
  }

  /** Ingest a payload from the relay JSON-RPC channel (not the local HTTP server); connectionId is stamped here. Main is still the SSH trust boundary, so re-run the canonical normalizer before caching. */
  ingestRemote(
    envelope: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      env?: string
      version?: string
      launchToken?: string
      hasExplicitPrompt?: boolean
      promptInteractionKey?: string
      hookEventName?: string
      toolUseId?: string
      toolAgentId?: string
      toolAgentType?: string
      providerSession?: unknown
      providerSessionOnly?: unknown
      isReplay?: boolean
      payload: unknown
    },
    connectionId: string
  ): void {
    // Why: wire crosses a trust boundary — re-check/trim so an empty connectionId can't poison caches.
    if (typeof connectionId !== 'string') {
      return
    }
    const trimmedConnectionId = connectionId.trim()
    if (trimmedConnectionId.length === 0) {
      return
    }
    if (!envelope || typeof envelope.paneKey !== 'string') {
      return
    }
    // Why: trim paneKey to match the HTTP path, else remote-vs-local events for one pane diverge.
    const physicalPaneKey = envelope.paneKey.trim()
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN) {
      return
    }
    if (!parsedPaneKey) {
      return
    }
    if (envelope.tabId !== undefined && typeof envelope.tabId !== 'string') {
      return
    }
    if (envelope.worktreeId !== undefined && typeof envelope.worktreeId !== 'string') {
      return
    }
    // Why: mirror the HTTP path's readStringField — trim and treat empty-after-trim as undefined.
    const reportedTabId =
      envelope.tabId !== undefined && envelope.tabId.trim().length > 0
        ? envelope.tabId.trim()
        : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    if (this.shouldSuppressClosedTabStatus(paneKey)) {
      return
    }
    const worktreeId =
      envelope.worktreeId !== undefined && envelope.worktreeId.trim().length > 0
        ? envelope.worktreeId.trim()
        : undefined
    const hookEventName =
      typeof envelope.hookEventName === 'string' && envelope.hookEventName.trim().length > 0
        ? envelope.hookEventName.trim()
        : undefined
    const promptInteractionKey =
      typeof envelope.promptInteractionKey === 'string' &&
      envelope.promptInteractionKey.trim().length > 0
        ? envelope.promptInteractionKey.trim()
        : undefined
    const toolUseId =
      typeof envelope.toolUseId === 'string' && envelope.toolUseId.trim().length > 0
        ? envelope.toolUseId.trim()
        : undefined
    const toolAgentId =
      typeof envelope.toolAgentId === 'string' && envelope.toolAgentId.trim().length > 0
        ? envelope.toolAgentId.trim()
        : undefined
    const toolAgentType =
      typeof envelope.toolAgentType === 'string' && envelope.toolAgentType.trim().length > 0
        ? envelope.toolAgentType.trim()
        : undefined
    const providerSession = normalizeAgentProviderSession(envelope.providerSession) ?? undefined
    // Why: relay crosses a trust boundary — re-run the canonical normalizer to enforce caps/invariants (returns null on malformed).
    const normalizedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!normalizedPayload) {
      return
    }
    if (
      envelope.providerSessionOnly === true &&
      !isValidPiProviderSessionOnly(providerSession, normalizedPayload.agentType)
    ) {
      return
    }
    // Why: run the HTTP path's warn-once version/env-mismatch diagnostics with this.env as expected.
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event: AgentHookEventPayload = {
      paneKey,
      launchToken: envelope.launchToken,
      tabId,
      worktreeId,
      connectionId: trimmedConnectionId,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
      promptInteractionKey,
      hookEventName,
      toolUseId,
      toolAgentId,
      toolAgentType,
      providerSession,
      providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
      isReplay: envelope.isReplay === true ? true : undefined,
      payload: normalizedPayload
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(event)
  }

  async start(options?: {
    env?: string
    userDataPath?: string
    endpointNamespace?: string
  }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      // Why: dev builds share one userData path; namespace per instance while packaged keeps the stable path for PTY reconnect.
      this.endpointDir = options.endpointNamespace
        ? join(options.userDataPath, 'agent-hooks', options.endpointNamespace)
        : join(options.userDataPath, 'agent-hooks')
      this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
      this.lastStatusFilePath = join(this.endpointDir, LAST_STATUS_FILE_NAME)
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.lastWrittenJson = null
    // Why: hydrate before binding the listener so an early hook POST runs against a populated map.
    if (this.lastStatusFilePath) {
      this.hydrateLastStatusFromDisk()
    }
    this.captureHydratedAuthorityCommitments()
    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      // Why: bound request time so a stalled client can't hold a socket open (slowloris).
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        req.destroy()
      })

      try {
        const body = await readRequestBody(req)
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname === CLAUDE_STATUSLINE_PATHNAME) {
          const statusLineEvent = parseClaudeStatusLineBody(body)
          if (statusLineEvent) {
            this.onClaudeStatusLine?.(statusLineEvent)
          }
          res.writeHead(204)
          res.end()
          return
        }
        const source = resolveHookSource(pathname)
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        trackEmptyPaneKeyHook(body)
        const aliasedBody = this.normalizeHookBodyPaneKeyAlias(body)
        const normalized = normalizeHookPayload(this.state, source, aliasedBody, this.env)
        if (normalized && !this.shouldSuppressClosedTabStatus(normalized.paneKey)) {
          this.recordCurrentAuthorityObservation(normalized)
          const enriched = this.applyNormalizedStatus(normalized)
          this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
          this.scheduleCodexSubagentPoll(source, aliasedBody, enriched)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: fail open — return success on malformed payloads so a broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    }
    // Why: node ignores a returned promise, so the handler must settle it itself; handleRequest never rejects.
    this.server = createServer((req, res) => {
      void handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup reject-handler for a logging one so a later runtime 'error' can't crash main as an unhandled event.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        this.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    // Why: flush the pending debounced write before clearing the map, else a hook <250ms before quit is lost on relaunch.
    this.flushStatusPersistSync()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
    this.onPaneStatusCleared = null
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    for (const timer of this.codexSubagentPollTimers.values()) {
      clearTimeout(timer)
    }
    this.codexSubagentPollTimers.clear()
    // Why: don't unlink the endpoint file — a stale file matches fail-open and avoids a TOCTOU race with a concurrent Orca.
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    this.lastStatusFilePath = null
    this.lastWrittenJson = null
    this.runtimeObservedStatusPaneKeys.clear()
    this.hydratedAuthorityCommitments = Object.freeze([])
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    this.currentAuthorityObservations.clear()
    this.promptSentDedupeByPaneKey.clear()
    this.closedAgentStatusTabIds.clear()
    this.closedAgentStatusPaneKeys.clear()
    this.connectionTimestampWatermarkById.clear()
    this.legacyPaneKeyAliases.clear()
    clearAllListenerCaches(this.state)
    this.notifyStatusChangeListeners()
  }

  /** Drop only the status row (user dismissal); do NOT wipe prompt/tool caches since the pane's agent may still be alive. Use clearPaneState for PTY-teardown. */
  dropStatusEntry(paneKey: string): void {
    if (!this.deleteStatusEntry(paneKey, { preserveAuthority: true })) {
      return
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
  }

  /** Clear statuses proven to belong to one lost SSH transport. */
  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [paneKey, rawEntry] of this.state.lastStatusByPaneKey) {
      const entry = rawEntry as EnrichedAgentHookEventPayload
      // Why: unstamped rows can't be attributed to one host; leave them for normal pane teardown.
      if (entry.connectionId !== normalizedConnectionId) {
        continue
      }
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (deleted) {
        statusChanged = true
        if (deleted.payload.agentType === 'codex') {
          // Why: a replacement remote process may reuse the pane; don't merge it with the lost connection's children.
          this.state.codexSubagentRosterByPaneKey.delete(paneKey)
          this.state.codexLeadStateByPaneKey.delete(paneKey)
        }
      }
    }
    for (const [paneKey, evidence] of this.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      // Why: persist/notify once — one disconnect can own many panes.
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Why: always send the cutoff even with no matched entry — another host may have overwritten this pane's row.
    this.onPaneStatusCleared?.({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }

  private deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const existing = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return null
    }
    this.state.lastStatusByPaneKey.delete(resolvedPaneKey)
    if (!options?.preserveAuthority) {
      this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
    }
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearCodexSubagentPoll(resolvedPaneKey)
    this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    if (existing.payload.state === 'done') {
      this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    }
    return existing
  }

  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    const paneKeysToClear = new Set<string>()
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
      }
    }
    for (const key of this.state.lastPromptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.lastToolByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.antigravityCompletedTranscriptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.ampCompletedCacheKeys) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const paneKey of this.runtimeObservedStatusPaneKeys) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const paneKey of this.promptSentDedupeByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (paneCacheKeyMatchesTab(commitment.paneKey, tabId)) {
        paneKeysToClear.add(commitment.paneKey)
      }
    }

    let aliasChanged = false
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      const ownerMatches = paneCacheKeyMatchesTab(entry.stablePaneKey, tabId)
      if (ownerMatches) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeysToClear.add(legacyPaneKey)
        paneKeysToClear.add(entry.stablePaneKey)
        this.markPaneClosedForAgentStatus(legacyPaneKey)
        this.markPaneClosedForAgentStatus(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeysToClear)

    let statusChanged = false
    for (const paneKey of paneKeysToClear) {
      if (this.state.lastStatusByPaneKey.has(paneKey)) {
        statusChanged = true
      }
      this.clearAssistantMessageRetry(paneKey)
      this.clearCodexSubagentPoll(paneKey)
      clearPaneCacheState(this.state, paneKey)
      this.runtimeObservedStatusPaneKeys.delete(paneKey)
      this.currentAuthorityObservations.delete(paneKey)
      this.promptSentDedupeByPaneKey.delete(paneKey)
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (statusChanged || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  clearPaneState(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const hadStatus = this.state.lastStatusByPaneKey.has(resolvedPaneKey)
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearCodexSubagentPoll(resolvedPaneKey)
    clearPaneCacheState(this.state, resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, stablePaneKey] of this.legacyPaneKeyAliases) {
      if (stablePaneKey.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(stablePaneKey.stablePaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.currentAuthorityObservations.delete(legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus || authorityChanged) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.onPaneStatusCleared?.({ paneKey: resolvedPaneKey })
    }
  }

  /** Second reap path for restored Claude subagent rows: drop the ones whose pane
   *  has no live local agent process behind it any more. A PTY that dies while Orca
   *  is down never runs the teardown that clears pane state, so hydrate rebuilds a
   *  roster nothing can ever retire — the inventory reap needs the parent to emit a
   *  complete `background_tasks` list and an idle parent never does. The row then
   *  gates the pane 'working' for the rest of its life and hibernation, which
   *  requires 'done', can never reclaim the agent's heap.
   *
   *  Both the execution host and relay binding must prove local ownership before
   *  targeted PTY liveness is consulted. Panes that reported in this runtime are
   *  also skipped. Returns the number of panes changed. */
  async reapRestoredClaudeSubagentsWithoutLiveAgent(
    isLocalExecutionHost: (worktreeId: string | undefined) => boolean,
    isLocalPaneAgentLive: (paneKey: string) => Promise<boolean>,
    isLocalPaneLivenessEvidenceCurrent: (paneKey: string) => boolean
  ): Promise<number> {
    const candidates: { paneKey: string; entry: EnrichedAgentHookEventPayload }[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (
        enriched.payload.agentType === 'claude' &&
        enriched.connectionId === null &&
        isLocalExecutionHost(enriched.worktreeId) &&
        claudeRosterHasRestoredSnapshotSubagent(
          this.state.claudeSubagentRosterByPaneKey.get(paneKey)
        ) &&
        !this.runtimeObservedStatusPaneKeys.has(paneKey)
      ) {
        candidates.push({ paneKey, entry: enriched })
      }
    }
    const liveness = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await isLocalPaneAgentLive(candidate.paneKey)
        } catch {
          return true
        }
      })
    )
    let changedPanes = 0
    for (const [index, candidate] of candidates.entries()) {
      const { paneKey, entry: enriched } = candidate
      if (
        liveness[index] ||
        !isLocalPaneLivenessEvidenceCurrent(paneKey) ||
        this.state.lastStatusByPaneKey.get(paneKey) !== enriched ||
        this.runtimeObservedStatusPaneKeys.has(paneKey) ||
        !isLocalExecutionHost(enriched.worktreeId)
      ) {
        continue
      }
      if (!reapRestoredClaudeSubagentsForDeadPane(this.state, paneKey)) {
        continue
      }
      changedPanes += 1
      const roster = this.state.claudeSubagentRosterByPaneKey.get(paneKey)
      const subagents = claudeRosterToSnapshots(roster)
      // Why: the pane's persisted 'working' was the child gate holding a finished
      // lead open (subagent events never set lead state). With the last working row
      // gone and no process left to report, 'done' is the only truthful state — and
      // the one hibernation needs once this pane's agent is restored.
      const state =
        enriched.payload.state === 'working' && !claudeRosterHasWorkingSubagent(roster)
          ? 'done'
          : enriched.payload.state
      const stateChanged = state !== enriched.payload.state
      const reconciledAt = stateChanged
        ? Math.max(Date.now(), enriched.receivedAt + 1)
        : enriched.receivedAt
      const reconciled: EnrichedAgentHookEventPayload = {
        ...enriched,
        receivedAt: reconciledAt,
        stateStartedAt: stateChanged ? reconciledAt : enriched.stateStartedAt,
        payload: { ...enriched.payload, state, subagents }
      }
      this.state.lastStatusByPaneKey.set(paneKey, reconciled)
    }
    if (changedPanes > 0) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    return changedPanes
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION
    }
    // Why: hooks source this file at invocation; dev namespaces it so parallel `pnpm dev` runs don't steal each other's hooks.
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  /** Test/diagnostic accessor for the on-disk last-status file path. */
  get lastStatusPath(): string | null {
    return this.lastStatusFilePath
  }

  private maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION
    })
    this.endpointFileWritten = ok
  }

  private hydrateLastStatusFromDisk(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: keep hydrate idempotent so a future re-start path can't merge prior-session state.
    this.state.lastStatusByPaneKey.clear()
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    let raw: string
    try {
      raw = readFileSync(this.lastStatusFilePath, 'utf8')
    } catch (err) {
      // Why: missing file is normal (first launch); other errors degrade to empty hydration + one warn.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-hooks] failed to read last-status file:', err)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[agent-hooks] last-status file is not an object; ignoring')
      return
    }
    const file = parsed as Partial<LastStatusFile>
    if (file.version !== LAST_STATUS_FILE_VERSION) {
      console.warn(
        `[agent-hooks] last-status file version mismatch (${String(
          file.version
        )} != ${LAST_STATUS_FILE_VERSION}); ignoring`
      )
      return
    }
    const entries = file.entries
    if (typeof entries !== 'object' || entries === null) {
      console.warn('[agent-hooks] last-status file entries missing or wrong shape; ignoring')
      return
    }
    let hydrated = 0
    let dropped = 0
    let prunedLegacyClaudeSubagents = 0
    let scrubbedLegacyLaunchTokens = 0
    // Why: drop entries older than HYDRATE_MAX_AGE_MS to bound disk growth (one Date.now() for a consistent cutoff).
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, rawEntry] of Object.entries(entries)) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const rawResolvedEntry =
        resolvedPaneKey === paneKey || typeof rawEntry !== 'object' || rawEntry === null
          ? rawEntry
          : { ...(rawEntry as Record<string, unknown>), paneKey: resolvedPaneKey }
      const entry = sanitizeHydratedEntry(resolvedPaneKey, rawResolvedEntry)
      if (entry && entry.receivedAt >= ttlCutoff) {
        const launchTokenHash = readPersistedLaunchTokenHash(rawResolvedEntry)
        if (launchTokenHash) {
          this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, launchTokenHash)
          const evidence = this.toAuthorityEvidence(entry, launchTokenHash)
          if (evidence) {
            this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, evidence)
          }
        }
        if (
          typeof rawResolvedEntry === 'object' &&
          rawResolvedEntry !== null &&
          typeof (rawResolvedEntry as Record<string, unknown>).launchToken === 'string'
        ) {
          scrubbedLegacyLaunchTokens += 1
        }
        const hydratedPayload = dropHydratedIdleClaudeSubagents(entry.payload)
        if (hydratedPayload !== entry.payload) {
          prunedLegacyClaudeSubagents +=
            (entry.payload.subagents?.length ?? 0) - (hydratedPayload.subagents?.length ?? 0)
          entry.payload = hydratedPayload
        }
        this.state.lastStatusByPaneKey.set(resolvedPaneKey, entry)
        if (entry.connectionId) {
          // Why: a restart can see an earlier wall clock; seed ordering so new events stay after disk state.
          const previousWatermark = this.connectionTimestampWatermarkById.get(entry.connectionId)
          this.connectionTimestampWatermarkById.set(
            entry.connectionId,
            Math.max(previousWatermark ?? -1, entry.receivedAt)
          )
        }
        // Why: restore live child hierarchy immediately; provider-specific reconciliation reaps stale seeds.
        if (entry.payload.agentType === 'codex') {
          seedCodexStateFromSnapshot(this.state, resolvedPaneKey, entry.payload)
        } else if (entry.payload.agentType === 'claude' && entry.payload.subagents) {
          seedClaudeSubagentRosterFromSnapshots(
            this.state,
            resolvedPaneKey,
            entry.payload.subagents
          )
        }
        hydrated += 1
      } else {
        dropped += 1
      }
    }
    for (const [paneKey, rawCommitment] of Object.entries(file.authorityCommitments ?? {})) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const commitment = sanitizePersistedAuthorityCommitment(resolvedPaneKey, rawCommitment)
      if (!commitment || commitment.observedAt < ttlCutoff) {
        dropped += 1
        continue
      }
      const existing = this.persistedAuthorityCommitmentsByPaneKey.get(resolvedPaneKey)
      if (existing && !authorityCommitmentsMatch(existing, commitment)) {
        this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
        this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
        dropped += 1
        continue
      }
      this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, commitment)
      this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, commitment.launchTokenHash)
    }
    if (dropped > 0) {
      console.warn(
        `[agent-hooks] last-status hydrate dropped ${dropped} entries (kept ${hydrated})`
      )
    }
    if (dropped > 0 || prunedLegacyClaudeSubagents > 0 || scrubbedLegacyLaunchTokens > 0) {
      // Why: persist load-time pruning and bearer scrubbing once.
      this.runStatusPersist()
    } else if (hydrated > 0) {
      // Why: prime dedup from raw bytes (not re-serialized) only when hydration was lossless.
      this.lastWrittenJson = raw
    }
  }

  private captureHydratedAuthorityCommitments(): void {
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    for (const entry of this.state.lastStatusByPaneKey.values()) {
      const evidence = this.toAuthorityEvidence(
        entry as EnrichedAgentHookEventPayload,
        this.hydratedLaunchTokenHashByPaneKey.get(entry.paneKey)
      )
      if (evidence && !this.persistedAuthorityCommitmentsByPaneKey.has(entry.paneKey)) {
        this.persistedAuthorityCommitmentsByPaneKey.set(entry.paneKey, evidence)
      }
    }
    this.hydratedAuthorityCommitments = Object.freeze(
      Array.from(this.persistedAuthorityCommitmentsByPaneKey.values())
    )
  }

  private recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void {
    const evidence = this.toAuthorityEvidence(payload)
    if (evidence) {
      this.currentAuthorityObservations.set(evidence.paneKey, evidence)
      this.persistedAuthorityCommitmentsByPaneKey.set(evidence.paneKey, evidence)
      this.hydratedLaunchTokenHashByPaneKey.set(evidence.paneKey, evidence.launchTokenHash)
    }
  }

  private toAuthorityEvidence(
    payload: AgentHookEventPayload | EnrichedAgentHookEventPayload,
    launchTokenHashOverride?: string
  ): AgentHookAuthorityEvidence | null {
    const launchToken = payload.launchToken?.trim()
    const launchTokenHash =
      launchTokenHashOverride ??
      (launchToken ? createHash('sha256').update(launchToken).digest('hex') : null)
    if (!launchTokenHash) {
      return null
    }
    return Object.freeze({
      paneKey: payload.paneKey,
      launchTokenHash,
      connectionId: payload.connectionId,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      observedAt: 'receivedAt' in payload ? payload.receivedAt : Date.now()
    })
  }

  private serializeStatusFile(): string {
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    for (const [paneKey, commitment] of this.persistedAuthorityCommitmentsByPaneKey) {
      authorityCommitments[paneKey] = { ...commitment }
    }
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // Why: never persist invalid keys (matches the hydrate-path invariant).
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const {
        promptInteractionKey: _promptInteractionKey,
        launchToken,
        ...persistedPayload
      } = payload as EnrichedAgentHookEventPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      entries[paneKey] = {
        ...persistedPayload,
        ...(launchTokenHash ? { launchTokenHash } : {})
      }
      const commitment = this.toAuthorityEvidence(payload, launchTokenHash)
      if (commitment && !conflictedCommitments.has(paneKey)) {
        const existing = authorityCommitments[paneKey]
        if (existing && !authorityCommitmentsMatch(existing, commitment)) {
          delete authorityCommitments[paneKey]
          conflictedCommitments.add(paneKey)
        } else {
          authorityCommitments[paneKey] = { ...commitment }
        }
      }
    }
    const file: LastStatusFile = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments
    }
    return JSON.stringify(file)
  }

  private scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: reset the timer each call so the write fires only after the last event in a burst.
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      this.runStatusPersist()
    }, STATUS_PERSIST_DEBOUNCE_MS)
    // Why: don't keep the event loop alive just for a status flush — quit already flushes sync.
    if (typeof this.statusPersistTimer.unref === 'function') {
      this.statusPersistTimer.unref()
    }
  }

  flushStatusPersistSync(): void {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
    if (!this.lastStatusFilePath) {
      return
    }
    this.runStatusPersist()
  }

  private runStatusPersist(): void {
    if (!this.lastStatusFilePath || !this.endpointDir) {
      return
    }
    const json = this.serializeStatusFile()
    if (json === this.lastWrittenJson) {
      return
    }
    const tmpPath = join(this.endpointDir, `.last-status-${process.pid}-${randomUUID()}.tmp`)
    let tmpWritten = false
    try {
      mkdirSync(this.endpointDir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.endpointDir, 0o700)
        } catch {
          // best-effort
        }
      }
      writeFileSync(tmpPath, json, { mode: 0o600 })
      tmpWritten = true
      renameSync(tmpPath, this.lastStatusFilePath)
      this.lastWrittenJson = json
    } catch (err) {
      console.warn('[agent-hooks] failed to write last-status file:', err)
      if (tmpWritten) {
        try {
          unlinkSync(tmpPath)
        } catch {
          // tmp already gone
        }
      }
    }
  }

  /** Test-only accessor for the per-instance listener state (narrow getter avoids an `as unknown` cast). */
  _getStateForTests(): HookListenerState {
    return this.state
  }

  _resetPromptSentDedupeForTests(): void {
    this.promptSentDedupeByPaneKey.clear()
  }

  _resetConnectionTimestampWatermarksForTests(): void {
    this.connectionTimestampWatermarkById.clear()
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so tests exercise the live caches.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(agentHookServer._getStateForTests(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(agentHookServer._getStateForTests())
    agentHookServer._resetPromptSentDedupeForTests()
    agentHookServer._resetConnectionTimestampWatermarksForTests()
  }
}
