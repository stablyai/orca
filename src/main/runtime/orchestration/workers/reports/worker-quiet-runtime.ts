import type { AgentStatusStoreView } from '../../../sidebar-inputs/workspace-activity-facts-producer'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import { getRuntimeDesktopSurface } from '../../../construction/runtime-desktop-surface'
import { WorkerQuietSweep, type WorkerQuietObservation } from './worker-quiet-sweep'
import { latestWorkerQuietNotice, reportWorkerQuiet } from './worker-quiet-report'
import type { WorkerTurnStopDispatch } from '../turn-stops/worker-turn-stop-report'
import type { resolveTerminalWorkerDispatch } from '../turn-stops/terminal-worker-turn-stops'
import type {
  DispatchContextRow,
  RemoteDispatchAttachmentRow
} from '../../db/orchestration-records'
import {
  DISPATCH_CONTEXT_COLUMN_LIST,
  REMOTE_DISPATCH_ATTACHMENT_COLUMN_LIST
} from '../../db/row-column-lists'
import {
  resolveStructuredWorkerIdentity,
  structuredWorkerSession
} from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

export function startWorkerQuietSweep(deps: {
  store: AgentStatusStoreView
  getDb: () => OrchestrationDb | null
  resolveTerminal: (paneKey: string) => ReturnType<typeof resolveTerminalWorkerDispatch>
  readPty: (paneKey: string) => RuntimePtyWorktreeRecord | null
  notify: (handle: string, type: string) => void
}): () => void {
  const candidates = new Map<
    string,
    { target: WorkerTurnStopDispatch; from: string; agent: string }
  >()
  const sweep = new WorkerQuietSweep(
    Date.now(),
    (id) => {
      const db = deps.getDb()
      return db ? latestWorkerQuietNotice(db, id) : undefined
    },
    (row, notice) => {
      const candidate = candidates.get(row.dispatchId)
      const db = deps.getDb()
      return (
        !!db &&
        !!candidate &&
        reportWorkerQuiet(db, candidate.target, { ...row, ...candidate }, notice, deps.notify)
      )
    }
  )
  const run = (): void => {
    try {
      candidates.clear()
      const db = deps.getDb()
      if (!db) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the canonical column list covers the dispatch row.
      const local = db.db
        .prepare(
          `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE status IN ('pending', 'dispatched') AND capability_revoked_at IS NULL`
        )
        .all() as DispatchContextRow[]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the canonical column list covers the attachment row.
      const remote = db.db
        .prepare(
          `SELECT ${REMOTE_DISPATCH_ATTACHMENT_COLUMN_LIST} FROM remote_dispatch_attachments WHERE state IN ('starting', 'ready', 'start_unknown')`
        )
        .all() as RemoteDispatchAttachmentRow[]
      type Target =
        | { kind: 'local'; dispatch: DispatchContextRow }
        | { kind: 'remote'; attachment: RemoteDispatchAttachmentRow }
      const targets: Target[] = [
        ...local.map((dispatch): Target => ({ kind: 'local', dispatch })),
        ...remote.map((attachment): Target => ({ kind: 'remote', attachment }))
      ]
      const observations: WorkerQuietObservation[] = []
      for (const target of targets) {
        const dispatchId =
          target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
        const from =
          target.kind === 'local'
            ? target.dispatch.assignee_handle
            : target.attachment.terminal_handle
        const paneKey =
          target.kind === 'local' ? target.dispatch.assignee_pane_key : target.attachment.pane_key
        if (!from) {
          continue
        }
        const openedAt = Date.parse(
          `${(target.kind === 'local'
            ? target.dispatch.created_at
            : target.attachment.created_at
          ).replace(' ', 'T')}Z`
        )
        const identity = resolveStructuredWorkerIdentity(from, db)
        if (identity) {
          const running = structuredWorkerSession(identity)
          if (running.kind !== 'here') {
            continue
          }
          const host = getStructuredAgentSessionHost()
          const progress = host?.attentionReads.workerProgress(running.sessionId)
          if (!progress || host?.readStatusSummary(running.sessionId)?.status !== 'working') {
            continue
          }
          candidates.set(dispatchId, {
            target,
            from,
            agent: identity.agent ?? host?.sessionAgent(running.sessionId) ?? 'agent'
          })
          observations.push({ dispatchId, working: true, ...progress })
          continue
        }
        if (!paneKey) {
          continue
        }
        const resolved = deps.resolveTerminal(paneKey)
        if (
          !resolved ||
          (resolved.target.kind === 'local'
            ? resolved.target.dispatch.id
            : resolved.target.attachment.dispatch_id) !== dispatchId
        ) {
          continue
        }
        const row = deps.store.getStatusSnapshotForPane(paneKey)[0]
        const pty = deps.readPty(paneKey)
        const progress = deps.store.producerProgress?.get(paneKey)
        let tool: { name: string; startedAt: number } | undefined
        for (const call of progress?.tools.values() ?? []) {
          if (!tool || call.startedAt < tool.startedAt) {
            tool = call
          }
        }
        candidates.set(dispatchId, {
          target,
          from,
          agent: row?.agentType ?? pty?.launchAgent ?? pty?.foregroundAgent ?? 'agent'
        })
        observations.push({
          dispatchId,
          turnStartedAt: row?.turnStartedAt ?? openedAt,
          working: row
            ? row.state === 'working'
            : pty?.lastAgentStatus === 'working' && pty.lastAgentStatusObservedLive,
          restoredUnconfirmed: row?.restoredUnconfirmed,
          connected: pty?.connected ?? false,
          connectionId: row?.connectionId,
          workingSince: progress
            ? undefined
            : (pty?.lastAgentStatusStartedAtEpochMs ?? row?.stateStartedAt),
          lastProducerEventAt: progress?.lastProducerEventAt,
          tool:
            tool ??
            (row?.agentType === 'claude' && row.workingMode === 'monitoring'
              ? { name: 'background work', startedAt: row.stateStartedAt }
              : undefined)
        })
      }
      sweep.sweep(
        observations,
        Date.now(),
        targets.map((target) =>
          target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
        )
      )
    } catch (error) {
      console.warn('[orchestration] quiet worker sweep failed', error)
    }
  }
  const detachResume = getRuntimeDesktopSurface().onResume?.(() => sweep.resume(Date.now()))
  const timer = setInterval(run, 60_000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    detachResume?.()
  }
}
