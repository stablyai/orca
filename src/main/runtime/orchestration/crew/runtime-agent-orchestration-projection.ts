import type { OrchestrationTerminalCandidates } from './orchestration-terminal-candidates'
import { composeOrchestrationDispatch } from './orchestration-dispatch-context'
import { orchestrationProjectionFacts } from './orchestration-projection-facts'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { OrchestrationCompatibilityTerminalAuthority } from '../terminal-authority/orchestration-compatibility-authority'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import type { OrchestrationDb } from '../db/orchestration-db'
import { projectWorkerAttentionContext } from '../workers/reports/worker-attention-context'
import type { AgentSessionRecordReader } from '../addressing/session-lineage/structured-session-lineage'
import { createOrchestrationProjectionScope } from './runtime-agent-orchestration-scope'
import { isRecentPresentationDispatch } from '../db/dispatch-context/dispatch-presentation'
import type { DispatchContextRow } from '../db/orchestration-records'
import type { PtyPaneOf } from '../../terminal/surface/pty-pane-query'
import {
  createDispatchSessionLivenessReader,
  type DispatchSessionObserver
} from '../workers/lifecycle/session-worker-liveness'

export type RuntimeAgentOrchestrationDependencies = {
  captureTerminalCandidates?(): OrchestrationTerminalCandidates
  getDb(): OrchestrationDb | null
  getLeaves(): Iterable<RuntimeLeafRecord>
  getPtys(): Iterable<RuntimePtyWorktreeRecord>
  paneOf: PtyPaneOf
  issueLeafHandle(leaf: RuntimeLeafRecord): string
  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string
  makePaneKey(leaf: RuntimeLeafRecord): string
  getWorktreeId(handle: string): string | null
  getHandleForPaneKey(paneKey: string): string | null
  getPaneKey(handle: string): string | null
  getDispatchAuthority(handle: string): OrchestrationCompatibilityTerminalAuthority | null
  getAgentStatusSnapshot(): readonly FleetAgentStatusEvidence[]
  getAgentStatusForPaneKey?(
    paneKey: string,
    contextForPane?: (paneKey: string) => AgentStatusOrchestrationContext | undefined
  ): readonly FleetAgentStatusEvidence[]
  getSessionRecords(): AgentSessionRecordReader | null
}

export type DispatchProjectionOptions = {
  // Handles are process-local; pane identity still names the Dispatch after restart.
  paneKey?: string
  evidence?: FleetAgentStatusEvidence
  observeSession?: DispatchSessionObserver
  deferAttention?: boolean
}

export class RuntimeAgentOrchestrationProjection {
  constructor(private readonly deps: RuntimeAgentOrchestrationDependencies) {}

  buildByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    const raw = this.deps.getDb()
    const source = raw?.db ? orchestrationProjectionFacts(raw) : undefined
    if (raw?.db && !source) {
      return undefined
    }
    const db = source?.view ?? raw
    if (!db || (source ? source.rows().next().done : db.hasAnyDispatchContexts?.() === false)) {
      return undefined
    }
    const scope = createOrchestrationProjectionScope(db, this.deps)
    const contexts: Record<string, AgentStatusOrchestrationContext> = {}
    const terminals = new Map<string, Iterable<string>>()
    const terminalCandidates = this.deps.captureTerminalCandidates?.()
    const expanded = new Set<ReturnType<OrchestrationTerminalCandidates>>()
    for (const candidate of source?.rows() ?? []) {
      const handle =
        candidate.assignee_handle && this.deps.getWorktreeId(candidate.assignee_handle) !== null
          ? candidate.assignee_handle
          : candidate.assignee_pane_key
            ? this.deps.getHandleForPaneKey(candidate.assignee_pane_key)
            : null
      const paneKey = handle ? this.deps.getPaneKey(handle) : null
      for (const address of new Set([paneKey, candidate.assignee_pane_key])) {
        if (!address) {
          continue
        }
        const groups =
          terminalCandidates?.(address) ??
          (handle && paneKey ? [{ paneKey, handles: [handle] }] : [])
        if (expanded.has(groups)) {
          continue
        }
        expanded.add(groups)
        for (const group of groups) {
          if (!terminals.has(group.paneKey)) {
            terminals.set(group.paneKey, group.handles)
          }
        }
      }
    }
    const statuses =
      source && this.deps.getAgentStatusForPaneKey
        ? [
            ...new Set([
              ...terminals.keys(),
              ...[...source.rows()].flatMap((row) =>
                row.assignee_orca_session_id ? [scope.resolve(row.assignee_orca_session_id)] : []
              )
            ])
          ].flatMap((pane) =>
            this.deps.getAgentStatusForPaneKey!(pane, (key) => this.identityContext(key, db, scope))
          )
        : this.deps.getAgentStatusSnapshot()
    const evidenceByPaneKey = new Map(
      statuses.map((evidence) => [evidence.activity.paneKey, evidence])
    )
    const sessions = createDispatchSessionLivenessReader(db, statuses, scope.records)
    const observeSession = sessions.observe
    const batchAttention = typeof db.getWorkerAttentionFactsForDispatches === 'function'
    for (const [paneKey, handles] of terminals) {
      for (const handle of handles) {
        const context = this.getForHandle(
          handle,
          db,
          {
            paneKey,
            evidence: evidenceByPaneKey.get(paneKey),
            observeSession,
            deferAttention: batchAttention
          },
          scope
        )
        if (context) {
          contexts[paneKey] = context
          break
        }
      }
    }
    for (const [paneKey, { dispatch }] of scope.sessionDispatches()) {
      if (!contexts[paneKey]) {
        contexts[paneKey] = this.projectDispatch(
          dispatch,
          dispatch.assignee_handle ?? '',
          db,
          {
            paneKey,
            evidence: evidenceByPaneKey.get(paneKey),
            observeSession,
            deferAttention: batchAttention
          },
          scope
        )
      }
    }
    const entries = Object.entries(contexts)
    if (entries.length === 0) {
      return undefined
    }
    if (batchAttention) {
      const now = scope.now
      const factsByDispatch = db.getWorkerAttentionFactsForDispatches(
        entries.map(([, context]) => context.dispatchId),
        now
      )
      for (const [paneKey, context] of entries) {
        const facts = factsByDispatch.get(context.dispatchId)
        if (facts) {
          contexts[paneKey] = {
            ...context,
            attention: projectWorkerAttentionContext({
              facts,
              isRoot: facts.isRoot,
              evidence: evidenceByPaneKey.get(paneKey),
              session: sessions.observed(context.dispatchId),
              now
            })
          }
        }
      }
    }
    return contexts
  }

  getForPaneKey(paneKey: string): AgentStatusOrchestrationContext | undefined {
    const raw = this.deps.getDb()
    if (!raw) {
      return undefined
    }
    const source = raw.db ? orchestrationProjectionFacts(raw) : undefined
    if (raw.db && !source) {
      return undefined
    }
    const db = source?.view ?? raw
    const scope = createOrchestrationProjectionScope(db, this.deps)
    const statuses =
      this.deps.getAgentStatusForPaneKey?.(paneKey, (key) =>
        this.identityContext(key, db, scope)
      ) ?? this.deps.getAgentStatusSnapshot().filter((entry) => entry.activity.paneKey === paneKey)
    const options = {
      paneKey,
      evidence: statuses.at(-1),
      observeSession: createDispatchSessionLivenessReader(db, statuses, scope.records).observe
    }
    const groups = this.deps.captureTerminalCandidates?.()(paneKey)
    const fallback = this.deps.getHandleForPaneKey(paneKey)
    const handles =
      groups?.find((group) => group.paneKey === paneKey)?.handles ?? (fallback ? [fallback] : [])
    for (const handle of handles) {
      const terminal = this.getForHandle(handle, db, options, scope)
      if (terminal) {
        return terminal
      }
    }
    const parsed = parsePaneKey(paneKey)
    const prefix = 'structured-agent-session-'
    if (!parsed?.tabId.startsWith(prefix)) {
      return undefined
    }
    const session = parsed.tabId.slice(prefix.length)
    if (structuredAgentSessionPaneKey(structuredAgentSessionTabId(session), session) !== paneKey) {
      return undefined
    }
    const ids = new Set([session])
    const visit = (id: string) => {
      for (const predecessor of scope.records?.listClearedFrom?.(id) ?? []) {
        if (!ids.has(predecessor)) {
          ids.add(predecessor)
          visit(predecessor)
        }
      }
    }
    visit(session)
    // Old record readers have no predecessor index; only their compatibility path enumerates.
    if (scope.records && !scope.records.listClearedFrom) {
      for (const record of scope.records.listRecords()) {
        ids.add(record.sessionId)
      }
    }
    const candidate = scope.sessionDispatches([...ids]).get(paneKey)
    return candidate
      ? this.projectDispatch(
          candidate.dispatch,
          candidate.dispatch.assignee_handle ?? '',
          db,
          options,
          scope
        )
      : undefined
  }

  private identityContext(
    paneKey: string,
    db: OrchestrationDb,
    scope: ReturnType<typeof createOrchestrationProjectionScope>
  ) {
    const handle = this.deps.getHandleForPaneKey(paneKey)
    return handle
      ? this.getForHandle(handle, db, { paneKey, deferAttention: true }, scope)
      : undefined
  }

  getForHandle(
    handle: string,
    db = this.deps.getDb(),
    options: DispatchProjectionOptions = {},
    scope = createOrchestrationProjectionScope(db, this.deps)
  ): AgentStatusOrchestrationContext | undefined {
    const facts = db?.db ? orchestrationProjectionFacts(db, scope.now) : undefined
    if (db?.db && !facts) {
      return undefined
    }
    if (facts && facts.view !== db) {
      db = facts.view
      scope = createOrchestrationProjectionScope(db, this.deps, scope.now)
    }
    const { paneKey } = options
    const dispatch =
      db?.getActiveDispatchForTerminal?.(handle, paneKey) ?? this.getRecent(handle, db, scope.now)
    if (!dispatch) {
      return undefined
    }
    const read = () => this.projectDispatch(dispatch, handle, db, options, scope)
    return facts ? facts.withDispatch(dispatch.id, read) : read()
  }

  private projectDispatch(
    dispatch: DispatchContextRow,
    handle: string,
    db: OrchestrationDb | null,
    options: DispatchProjectionOptions,
    scope: ReturnType<typeof createOrchestrationProjectionScope>
  ): AgentStatusOrchestrationContext {
    const facts = db?.db ? orchestrationProjectionFacts(db, scope.now) : undefined
    if (facts && db !== facts.view) {
      db = facts.view
    }
    return facts
      ? facts.withDispatch(dispatch.id, () =>
          composeOrchestrationDispatch(this.deps, dispatch, handle, db, options, scope)
        )
      : composeOrchestrationDispatch(this.deps, dispatch, handle, db, options, scope)
  }

  private getRecent(handle: string, db: OrchestrationDb | null, now: number) {
    const dispatch = db?.getLatestDispatchForTerminal?.(handle)
    return dispatch && isRecentPresentationDispatch(dispatch, now) ? dispatch : undefined
  }
}
