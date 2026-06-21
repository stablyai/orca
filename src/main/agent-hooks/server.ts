/* eslint-disable max-lines -- Why: this file owns the loopback HTTP adapter, the on-disk last-status persistence layer (hydrate, sanitize, TTL, atomic write, drop), and the relay ingest path in one place so the cache lifecycle (set → schedule → drain) lives next to the surfaces that mutate it. Splitting would force mutual `private` accessor scaffolding for a single class. */
// Why: this module is the Orca-main-process adapter for the shared
// agent-hook listener pipeline (`src/shared/agent-hook-listener.ts`). The
// listener internals (request parsing, payload normalization, endpoint-file
// writing, validation) live in `shared/` so the relay can host the same
// pipeline on the remote without dragging Electron in. This file owns:
//   - the loopback HTTP socket + bearer-token auth
//   - the IPC fanout (setListener / lastStatusByPaneKey replay)
//   - the `ingestRemote` entry point that bypasses HTTP for relay-forwarded
//     events (see docs/design/agent-status-over-ssh.md §5)
//   - the on-disk last-status cache (`last-status.json`) that survives
//     Orca restart so retained dashboard rows reappear on relaunch
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { AGENT_KIND_VALUES, type AgentKind } from '../../shared/telemetry-events'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  hasPendingAgentResultText,
  HOOK_REQUEST_SLOWLORIS_MS,
  MAX_PANE_KEY_LEN,
  normalizeHookPayload,
  parseFormEncodedBody,
  readRequestBody,
  resolveHookSource,
  warnOnHookEnvOrVersionMismatch,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import {
  AGENT_STATUS_STALE_AFTER_MS,
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
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { LegacyPaneKeyAliasEntry } from '../../shared/types'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'

export type { AgentHookSource }

// Why: server-process-only enrichment of the shared event payload. The shared
// listener emits `AgentHookEventPayload` (the bare event shape). For
// persistence and the dashboard's "did the agent transition since I last
// looked?" comparison, we attach `receivedAt` (when the latest event arrived
// for this pane) and `stateStartedAt` (when the current state first appeared).
// Stored in `state.lastStatusByPaneKey` via assignability — `AgentHookEventPayload`
// is the declared map value, and the extra fields ride along untouched because
// the shared module only writes/clears, never reads.
type EnrichedAgentHookEventPayload = AgentHookEventPayload & {
  receivedAt: number
  stateStartedAt: number
}

export type AgentHookStatusChangeEntry = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

type StatusChangeListener = (statuses: AgentHookStatusChangeEntry[]) => void
type PaneStatusClearListener = (paneKey: string) => void
type PaneKeyAliasPersistenceListener = (entries: LegacyPaneKeyAliasEntry[]) => void
type PaneKeyAliasEntry = {
  stablePaneKey: string
  ptyId: string | null
  updatedAt: number
}

// Why: name of the on-disk cache that survives Orca restart. Lives next to
// the endpoint file in userData/agent-hooks/ so all hook-server-owned cross-
// restart artifacts stay co-located.
const LAST_STATUS_FILE_NAME = 'last-status.json'
const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50
const INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS = 15_000

// Why: starts at 2 (not 1) because pre-merge dev iterations of this branch
// wrote a v1 shape with no receivedAt / stateStartedAt. Bumping to 2 means a
// developer who upgrades from an in-flight branch sees an empty hydration
// once instead of partially-typed legacy entries. New file format; never
// shipped to users at v1. A mismatched version is treated as a corrupt file
// (silent empty hydration).
const LAST_STATUS_FILE_VERSION = 2

// Why: trailing-edge debounce so a burst of hook events from a multi-agent
// run produces one disk write instead of N. The latency budget matches other
// hook-server batching; quit-time uses flushStatusPersistSync() for the
// guaranteed final flush.
const STATUS_PERSIST_DEBOUNCE_MS = 250
const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Why: bound the on-disk file's growth across many sessions. PTY-teardown
// eviction handles closed panes, but daemon-restored PTYs that never re-attach
// and crash-recovery paths where teardown never fires can leave entries
// pinned forever. 7 days matches the user-visible "still relevant?" horizon —
// older entries have almost certainly been resolved or abandoned and should
// not resurrect on hydrate.
const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

type LastStatusFile = {
  version: number
  entries: Record<string, EnrichedAgentHookEventPayload>
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

// Why: paneKey is `${tabId}:${leafUuid}` — validate the durable leaf suffix
// at write/hydrate time so legacy numeric rows fail closed.
export function isValidPaneKey(value: unknown): value is string {
  return typeof value === 'string' && parsePaneKey(value) !== null
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
  // Why: paneKey is `${tabId}:${leafUuid}`; a stored entry whose tabId field
  // diverges from the key's tab segment is corruption (renamer bug, manual
  // edit, future shape drift). Drop instead of hydrating an inconsistent row.
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
  // Why: connectionId is allowed to be null (local) or string (relay). Any
  // other shape is rejected so the post-merge typed surface stays honest.
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
  return {
    paneKey,
    launchToken: typeof record.launchToken === 'string' ? record.launchToken : undefined,
    tabId: typeof tabId === 'string' ? tabId : undefined,
    worktreeId: typeof worktreeId === 'string' ? worktreeId : undefined,
    connectionId,
    hasExplicitPrompt: record.hasExplicitPrompt === true ? true : undefined,
    hookEventName: typeof record.hookEventName === 'string' ? record.hookEventName : undefined,
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    toolAgentId: typeof record.toolAgentId === 'string' ? record.toolAgentId : undefined,
    toolAgentType: typeof record.toolAgentType === 'string' ? record.toolAgentType : undefined,
    providerSession: normalizeAgentProviderSession(record.providerSession) ?? undefined,
    payload,
    receivedAt,
    stateStartedAt
  }
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
    ...entry.payload
  }
}

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

function shouldKeepClaudePermissionVisible(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
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
  // Why: Claude can run subagents concurrently in one pane. Keep permission
  // sticky unless the next hook has a source-level execution id that the
  // PermissionRequest event itself does not expose.
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
    // Why: subagents can share `agent_type`; a concrete agent id is the
    // strongest available signal that the permission owner resumed execution.
    // Claude's approval path omits identity but preserves the original
    // tool_use_id on PostToolUse, so that exact id is also a safe clear signal.
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
    // Why: Claude emits PermissionRequest without tool_use_id, then reports the
    // approved command as PostToolUse with the original PreToolUse id.
    toolUseId: inheritedToolUseId
  }
}

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so hook scripts can stamp requests and
  // the server can detect dev vs. prod cross-talk. Set at start() from the
  // caller's knowledge of whether this is a packaged build.
  private env = 'production'
  private onAgentStatus: ((payload: EnrichedAgentHookEventPayload) => void) | null = null
  private onPaneStatusCleared: PaneStatusClearListener | null = null
  private statusChangeListeners = new Set<StatusChangeListener>()
  // Why: directory that holds the on-disk endpoint file. Set via start()'s
  // `userDataPath` option so the class has no direct Electron dependency
  // (keeps it mockable in the vitest node environment).
  private endpointDir: string | null = null
  private endpointFilePathCache: string | null = null
  private endpointFileWritten = false
  // Why: per-instance caches (warn-once Sets, lastPrompt/lastTool/lastStatus
  // by paneKey). Held on the instance instead of as module-level Maps so
  // tests can spin up multiple servers without state cross-contamination.
  private state: HookListenerState = createHookListenerState()
  // Why: hydrated last-status rows are useful UI continuity, but they are not
  // evidence of live agent work in this main-process runtime.
  private runtimeObservedStatusPaneKeys = new Set<string>()
  private legacyPaneKeyAliases = new Map<string, PaneKeyAliasEntry>()
  private paneKeyAliasPersistenceListener: PaneKeyAliasPersistenceListener | null = null
  // Why: full path to the on-disk last-status cache. Set in start() from
  // userDataPath. Null when the server runs without a userDataPath (e.g.
  // tests that skip the userDataPath option) — in that case, persistence is
  // a no-op and only in-memory replay applies.
  private lastStatusFilePath: string | null = null
  // Why: trailing-edge debounce timer. Captured per-instance so multiple
  // server instances in the same process (tests) don't share state.
  private statusPersistTimer: ReturnType<typeof setTimeout> | null = null
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private promptSentDedupeByPaneKey = new Map<string, AgentPromptSentDedupeEntry>()
  private promptSentHashSalt = randomBytes(16).toString('hex')
  // Why: identity check — skip writes when the JSON-stringified contents
  // exactly match the last successful disk write. Cheap protection against
  // re-firing trailing timers when nothing changed.
  private lastWrittenJson: string | null = null

  setListener(listener: ((payload: EnrichedAgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener call can't
    // starve subsequent panes from being replayed.
    for (const payload of this.state.lastStatusByPaneKey.values()) {
      try {
        // Why: cache values are stored as enriched payloads (with receivedAt /
        // stateStartedAt). The map's declared element type from the shared
        // listener is the bare AgentHookEventPayload because the shared module
        // never reads from this map; only this class does, and only enriched
        // values are ever inserted.
        listener({ ...(payload as EnrichedAgentHookEventPayload), isReplay: true })
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  subscribeStatusChanges(listener: StatusChangeListener): () => void {
    this.statusChangeListeners.add(listener)
    return () => {
      this.statusChangeListeners.delete(listener)
    }
  }

  setPaneStatusClearListener(listener: PaneStatusClearListener | null): void {
    this.onPaneStatusCleared = listener
  }

  /** Snapshot of the current cached statuses, in the IPC-shaped form the
   *  renderer consumes. Used by the `agentStatus:getSnapshot` IPC after
   *  workspace tabs have hydrated, so the dashboard catches up on any
   *  hook events that fired during startup. */
  getStatusSnapshot(): AgentStatusIpcPayload[] {
    return Array.from(this.state.lastStatusByPaneKey.values(), (entry) =>
      toAgentStatusIpcPayload(entry as EnrichedAgentHookEventPayload)
    )
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
    const payload = existing.payload
    const agentType: AgentType | undefined = payload.agentType
    // Why: Droid's Ctrl+C does not interrupt the current turn; repeated Ctrl+C
    // exits the CLI, which is handled by process/PTY lifecycle cleanup.
    if (agentType === 'droid' && request.intent === 'ctrl-c') {
      return false
    }
    // Why: these agents use the first Escape as a TUI/editor cancel. A single
    // Escape can leave the turn running, so only a deliberate double Escape
    // may infer an interrupted turn.
    if (
      (agentType === 'opencode' || agentType === 'copilot') &&
      request.intent === 'plain-escape' &&
      request.inputCount !== 2
    ) {
      return false
    }
    // Why: input-intent inference is a fallback for a missing final hook. A strict
    // baseline match keeps a delayed timer from overwriting any newer hook,
    // including same-millisecond prompt or agent identity changes.
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
        interrupted: true
      }
    })
    console.debug('[agent-hooks] inferred interrupted agent status', {
      paneKey: inferred.paneKey,
      agentType,
      intent: request.intent
    })
    return true
  }

  getStatusChangeSnapshot(): AgentHookStatusChangeEntry[] {
    return Array.from(this.state.lastStatusByPaneKey.entries(), ([paneKey, entry]) => {
      const enriched = entry as EnrichedAgentHookEventPayload
      return {
        state: enriched.payload.state,
        receivedAt: enriched.receivedAt,
        observedInCurrentRuntime: this.runtimeObservedStatusPaneKeys.has(paneKey)
      }
    })
  }

  private notifyStatusChangeListeners(): void {
    if (this.statusChangeListeners.size === 0) {
      return
    }
    const snapshot = this.getStatusChangeSnapshot()
    for (const listener of this.statusChangeListeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[agent-hooks] status-change listener threw', err)
      }
    }
  }

  private attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now()
  ): EnrichedAgentHookEventPayload {
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const stateStartedAt =
      previous && previous.payload.state === payload.payload.state ? previous.stateStartedAt : now
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
      // Why: hooks prove the user submitted a turn, but do not know which UI
      // launched the terminal; keep attribution low-cardinality and conservative.
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
    const now = Date.now()
    const identity = resolveAgentStatusIdentity({
      existing: previous
        ? {
            agentType: previous.payload.agentType,
            state: previous.payload.state,
            updatedAt: previous.receivedAt
          }
        : undefined,
      incoming: payload.payload.agentType,
      now
    })
    if (
      previous &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: payload.payload.state
      })
    ) {
      return previous
    }
    const identityResolvedPayload =
      identity.agentType === payload.payload.agentType
        ? payload
        : {
            ...payload,
            payload: {
              ...payload.payload,
              agentType: identity.agentType
            }
          }
    const effectivePayload = attachClaudePermissionToolUseId(previous, identityResolvedPayload)
    if (previous && shouldKeepClaudePermissionVisible(previous, effectivePayload)) {
      return previous
    }
    // Why: some TUIs can emit a delayed tool/working hook after Ctrl+C already
    // stopped the turn. Do not let that stale same-turn event resurrect the row.
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
    this.onAgentStatus?.(enriched)
    return enriched
  }

  private clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  private scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt = 1
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        const current = this.state.lastStatusByPaneKey.get(original.paneKey) as
          | EnrichedAgentHookEventPayload
          | undefined
        if (
          !current ||
          current.payload.agentType !== original.payload.agentType ||
          current.payload.prompt !== original.payload.prompt ||
          current.payload.lastAssistantMessage
        ) {
          return
        }
        const normalized = normalizeHookPayload(this.state, source, body, this.env)
        if (!normalized?.payload.lastAssistantMessage) {
          this.scheduleAssistantMessageRetry(source, body, original, attempt + 1)
          return
        }
        // Why: some agents POST Stop before their transcript/chat-history line
        // is flushed. Retry from a timer so the hook request returns immediately.
        this.applyNormalizedStatus(normalized)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
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

  registerPaneKeyAlias(
    legacyPaneKey: string,
    stablePaneKey: string,
    ptyId?: string,
    updatedAt = Date.now(),
    options?: { overwriteExisting?: boolean }
  ): void {
    const legacy = parseLegacyNumericPaneKey(legacyPaneKey)
    const stable = parsePaneKey(stablePaneKey)
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
    if (
      existing &&
      existing.stablePaneKey === stablePaneKey &&
      existing.ptyId === (normalizedPtyId ?? null) &&
      existing.updatedAt === normalizedUpdatedAt
    ) {
      return
    }
    this.legacyPaneKeyAliases.set(legacy.paneKey, {
      stablePaneKey,
      ptyId: normalizedPtyId ?? null,
      updatedAt: normalizedUpdatedAt
    })
    if (normalizedPtyId) {
      this.notifyPaneKeyAliasPersistenceListener()
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
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        const shouldClearStablePaneKey =
          options?.shouldClearStablePaneKey?.(entry.stablePaneKey) ?? true
        if (shouldClearStablePaneKey && this.state.lastStatusByPaneKey.has(entry.stablePaneKey)) {
          statusChanged = true
          clearedStatusPaneKeys.add(entry.stablePaneKey)
        }
        if (shouldClearStablePaneKey) {
          // Why: after hydrate, legacy rows are stored under the stable key. If
          // this PTY is later proven dead before ptyPaneKey is rebuilt, alias
          // cleanup is the only path that can evict that retained status.
          clearPaneCacheState(this.state, entry.stablePaneKey)
          this.runtimeObservedStatusPaneKeys.delete(entry.stablePaneKey)
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
        this.onPaneStatusCleared?.(paneKey)
      }
    }
  }

  private resolvePaneKeyAlias(paneKey: string): string {
    return this.legacyPaneKeyAliases.get(paneKey)?.stablePaneKey ?? paneKey
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
    // Why: pre-migration live shells keep posting their immutable numeric
    // ORCA_PANE_KEY. The reattach path proves the UUID leaf once, then this
    // bridge lets hook caches and renderer state use only the stable key.
    return { ...record, paneKey: stablePaneKey }
  }

  ingestTerminalStatus(event: {
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    payload: ParsedAgentStatusPayload
  }): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
      return
    }
    const tabId =
      event.tabId !== undefined && event.tabId.trim().length > 0 ? event.tabId.trim() : undefined
    if (tabId !== undefined && tabId !== parsedPaneKey.tabId) {
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
    // Why: OSC terminal status is a runtime/model observation, not a hook
    // prompt boundary. Keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus({
      paneKey,
      tabId,
      worktreeId,
      connectionId,
      payload: event.payload
    })
  }

  /** Ingest a payload that arrived over the relay JSON-RPC channel rather
   *  than the local HTTP server. `connectionId` is the SshChannelMultiplexer
   *  identity Orca holds (the wire envelope carries connectionId: null and
   *  Orca stamps the real value here). The relay has already normalized the
   *  payload via the shared listener module, but main is still the SSH trust
   *  boundary: re-run the canonical status normalizer before caching or
   *  persisting anything. The `env`/`version` fields are forwarded verbatim
   *  from the agent CLI's POST body on the remote and validated here so the
   *  warn-once diagnostics fire for real cross-build mismatches. */
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
      isReplay?: boolean
      payload: unknown
    },
    connectionId: string
  ): void {
    // Why: signature says non-empty, but the wire crosses a trust boundary —
    // re-check at runtime (and trim) so a whitespace-only or empty
    // connectionId can't poison caches.
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
    // Why: match the listener's HTTP path — `normalizeHookPayload` trims and
    // length-caps paneKey before caching, so the cache key here must follow
    // the same rule or remote-vs-local events for the same pane would diverge.
    const paneKey = this.resolvePaneKeyAlias(envelope.paneKey.trim())
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
    // Why: mirror the HTTP path's `readStringField` behavior — trim and treat
    // empty-after-trim as undefined rather than letting a literal "" leak
    // into the event.
    const tabId =
      envelope.tabId !== undefined && envelope.tabId.trim().length > 0
        ? envelope.tabId.trim()
        : undefined
    if (tabId !== undefined && tabId !== parsedPaneKey.tabId) {
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
    // Why: the relay is across a trust boundary; re-run the canonical
    // normalizer on the inner payload so prompt/agentType/toolName/toolInput
    // length caps, embedded-newline collapse, and the `interrupted`-only-on-
    // done invariant are enforced here too. Returns null on malformed input
    // (including invalid state), which subsumes the prior explicit state
    // check.
    const normalizedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!normalizedPayload) {
      return
    }
    // Why: run the same warn-once diagnostics the HTTP path runs (cross-build
    // version mismatch, dev-vs-prod env mismatch). Use `this.env` as the
    // expected env so the messages match what the local server produces.
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
      isReplay: envelope.isReplay === true ? true : undefined,
      payload: normalizedPayload
    }
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
      // Why: dev builds share one userData path, so callers can namespace the
      // endpoint file by dev instance while packaged builds keep the stable path
      // that lets long-lived PTYs reconnect after app restart.
      this.endpointDir = options.endpointNamespace
        ? join(options.userDataPath, 'agent-hooks', options.endpointNamespace)
        : join(options.userDataPath, 'agent-hooks')
      this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
      this.lastStatusFilePath = join(this.endpointDir, LAST_STATUS_FILE_NAME)
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.lastWrittenJson = null
    // Why: hydrate before binding the HTTP listener so any new hook POST
    // (which goes through state.lastStatusByPaneKey.set) runs against an
    // already-populated map. The renderer later pulls this map as a snapshot
    // after workspace tabs are hydrated.
    if (this.lastStatusFilePath) {
      this.hydrateLastStatusFromDisk()
    }
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

      // Why: bound request time so a slow/stalled client cannot hold a socket
      // open indefinitely (slowloris-style). The hook endpoints are local and
      // should complete in well under a second.
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        req.destroy()
      })

      try {
        const body = await readRequestBody(req)
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const source = resolveHookSource(pathname)
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        trackEmptyPaneKeyHook(body)
        const aliasedBody = this.normalizeHookBodyPaneKeyAlias(body)
        const normalized = normalizeHookPayload(this.state, source, aliasedBody, this.env)
        if (normalized) {
          const enriched = this.applyNormalizedStatus(normalized)
          this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: agent hooks must fail open. The receiver returns success for
        // malformed payloads so a newer or broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup error handler on success so a later runtime
      // error (e.g. EADDRINUSE during rebind, socket errors) doesn't reject
      // an already-settled promise or crash the main process as unhandled.
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
    // Why: flush any pending debounced write to disk BEFORE we clear the
    // in-memory map. Quit-time state must be captured even if the trailing
    // timer was scheduled but had not yet fired; otherwise a multi-agent
    // run that ended its last hook event <250 ms before quit would lose
    // that final delta on relaunch.
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
    // Why: intentionally do NOT delete the endpoint file on stop(). A stale
    // file points at a dead port, which matches the fail-open policy. Unlink
    // would introduce a TOCTOU race vs. a concurrent Orca instance.
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    this.lastStatusFilePath = null
    this.lastWrittenJson = null
    this.runtimeObservedStatusPaneKeys.clear()
    this.promptSentDedupeByPaneKey.clear()
    this.legacyPaneKeyAliases.clear()
    clearAllListenerCaches(this.state)
    this.notifyStatusChangeListeners()
  }

  /** Why: invoked from the renderer-driven agentStatus:drop IPC when a user
   *  dismisses a still-active pane's status row. We must NOT wipe
   *  lastPromptByPaneKey or lastToolByPaneKey here — the pane's agent may
   *  still be alive, and the next hook event would otherwise arrive with an
   *  empty prompt and missing tool snapshot until a fresh UserPromptSubmit
   *  lands. clearPaneState (which wipes all three caches) is the right shape
   *  only for PTY-teardown. */
  dropStatusEntry(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    if (!this.state.lastStatusByPaneKey.has(resolvedPaneKey)) {
      return
    }
    const existing = this.state.lastStatusByPaneKey.get(resolvedPaneKey)
    this.state.lastStatusByPaneKey.delete(resolvedPaneKey)
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
    if (existing?.payload.state === 'done') {
      this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
  }

  clearPaneState(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    // Why: only schedule a write when we actually evicted a status entry —
    // dropping prompt/tool caches for a pane that never produced a hook
    // event does not change the on-disk file, and skipping the write avoids
    // re-stat'ing on every dead-pane teardown.
    const hadStatus = this.state.lastStatusByPaneKey.has(resolvedPaneKey)
    this.clearAssistantMessageRetry(resolvedPaneKey)
    clearPaneCacheState(this.state, resolvedPaneKey)
    this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, stablePaneKey] of this.legacyPaneKeyAliases) {
      if (stablePaneKey.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.onPaneStatusCleared?.(resolvedPaneKey)
    }
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
    // Why: managed hooks source this file at invocation time. Packaged builds
    // use a stable file for restart handoff; dev callers pass a per-instance
    // namespace so parallel `pnpm dev` runs do not steal each other's hooks.
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
    // Why: defensive — keeps hydrate idempotent against repeated start()
    // calls; production callers always have an empty map here, but a future
    // re-start path must not silently merge prior-session state.
    this.state.lastStatusByPaneKey.clear()
    let raw: string
    try {
      raw = readFileSync(this.lastStatusFilePath, 'utf8')
    } catch (err) {
      // Why: missing file is the common case (first launch).
      // Other errors (EACCES, etc.) degrade to empty hydration with a single
      // warn so the dashboard renders normally.
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
    // Why: bound disk growth — drop anything older than HYDRATE_MAX_AGE_MS so
    // entries from worktrees archived weeks ago do not pile up forever. Use
    // Date.now() once to keep the cutoff consistent across all entries this
    // tick.
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, rawEntry] of Object.entries(entries)) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const rawResolvedEntry =
        resolvedPaneKey === paneKey || typeof rawEntry !== 'object' || rawEntry === null
          ? rawEntry
          : { ...(rawEntry as Record<string, unknown>), paneKey: resolvedPaneKey }
      const entry = sanitizeHydratedEntry(resolvedPaneKey, rawResolvedEntry)
      if (entry && entry.receivedAt >= ttlCutoff) {
        this.state.lastStatusByPaneKey.set(resolvedPaneKey, entry)
        hydrated += 1
      } else {
        dropped += 1
      }
    }
    if (dropped > 0) {
      console.warn(
        `[agent-hooks] last-status hydrate dropped ${dropped} entries (kept ${hydrated})`
      )
    }
    if (hydrated > 0 && dropped === 0) {
      // Why: prime from the raw on-disk bytes (not a re-serialization) so the
      // dedup is robust against future shape drift in serializeStatusFile.
      // Only prime when hydration was lossless — if entries were dropped
      // during sanitize, the in-memory map diverges from the on-disk bytes.
      this.lastWrittenJson = raw
    } else if (dropped > 0) {
      // Why: clean the stale on-disk file now so a user who has not run an
      // agent in 8+ days does not re-drop the same entries on every cold
      // boot. Synchronous variant is safe at start time and avoids
      // unref'd-timer-during-quit edge cases.
      this.runStatusPersist()
    }
  }

  private serializeStatusFile(): string {
    const entries: Record<string, EnrichedAgentHookEventPayload> = {}
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // Why: defensive — never persist invalid keys even if they slipped
      // into the in-memory map somehow. Same invariant the hydrate path
      // enforces.
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const { promptInteractionKey: _promptInteractionKey, ...persistedPayload } = payload
      entries[paneKey] = persistedPayload as EnrichedAgentHookEventPayload
    }
    const file: LastStatusFile = { version: LAST_STATUS_FILE_VERSION, entries }
    return JSON.stringify(file)
  }

  private scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: each call resets the timer; the disk write fires
    // STATUS_PERSIST_DEBOUNCE_MS after the LAST event in the burst.
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      this.runStatusPersist()
    }, STATUS_PERSIST_DEBOUNCE_MS)
    // Why: don't keep the event loop alive just for a status flush — quit
    // already triggers flushStatusPersistSync(). On Node 12+ unref() is a
    // no-op when called on an already-unref'd timer.
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

  /** Test-only accessor for the per-instance listener state. The `_internals`
   *  shim needs to reach this without exposing `state` on the public surface
   *  to renderer/main callers. AGENTS.md disallows `as unknown as X` escapes,
   *  so we expose a narrow getter rather than casting the private field. */
  _getStateForTests(): HookListenerState {
    return this.state
  }

  _resetPromptSentDedupeForTests(): void {
    this.promptSentDedupeByPaneKey.clear()
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so existing tests keep
  // exercising the same caches the live server uses.
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
  }
}
