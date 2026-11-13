import type { AgentStatusStoreView } from '../../../sidebar-inputs/workspace-facts/workspace-activity-facts-producer'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { resolveTerminalWorkerDispatch } from '../turn-stops/terminal-worker-turn-stops'
import type { WorkerQuietObservation } from './worker-quiet-sweep'
import { isAgentHookSource } from '../../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { chatWorkerDispatches } from '../turn-stops/chat-worker-error-escalation'
import {
  resolveStructuredWorkerIdentityForSession,
  structuredWorkerSession
} from '../../terminal-authority/structured-sessions/structured-worker-authority'

export type QuietWorkerSource = {
  store: AgentStatusStoreView
  readPaneKeys: () => Iterable<string>
  readPty: (paneKey: string) => RuntimePtyWorktreeRecord | null
  resolveTerminal: (paneKey: string) => ReturnType<typeof resolveTerminalWorkerDispatch>
}

export type QuietWorker = {
  target: NonNullable<ReturnType<typeof resolveTerminalWorkerDispatch>>['target']
  from: string
  agent: string
  observation: WorkerQuietObservation
}

/** Dispatch history owes no work: resolve custody only after current observations prove work. */
export function readQuietWorkers(deps: QuietWorkerSource, db: OrchestrationDb): QuietWorker[] {
  const workers = new Map<string, QuietWorker>()
  for (const paneKey of new Set(deps.readPaneKeys())) {
    const pty = deps.readPty(paneKey)
    if (!pty) {
      continue
    }
    const row = deps.store
      .getStatusSnapshotForPane(paneKey)
      .find((entry) => !entry.providerSessionOnly)
    if (
      row?.restoredUnconfirmed ||
      row?.structuredHost ||
      !(row
        ? row.state === 'working'
        : pty.lastAgentStatus === 'working' && pty.lastAgentStatusObservedLive)
    ) {
      continue
    }
    const resolved = deps.resolveTerminal(paneKey)
    if (
      !resolved ||
      (resolved.target.kind === 'local' && resolved.target.dispatch.capability_revoked_at)
    ) {
      continue
    }
    const { target } = resolved
    const record = target.kind === 'local' ? target.dispatch : target.attachment
    const dispatchId = target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
    const openedAt = Date.parse(`${record.created_at.replace(' ', 'T')}Z`)
    const progress = deps.store.producerProgress?.get(paneKey)
    const agent = row?.agentType ?? pty.launchAgent ?? pty.foregroundAgent ?? 'agent'
    let tool: { name: string; startedAt: number } | undefined
    for (const call of progress?.tools.values() ?? []) {
      if (!tool || call.startedAt < tool.startedAt) {
        tool = call
      }
    }
    workers.set(dispatchId, {
      target,
      from: resolved.handle,
      agent,
      observation: {
        dispatchId,
        turnStartedAt: row?.turnStartedAt ?? openedAt,
        working: true,
        connected: pty.connected === true,
        connectionId: row?.connectionId,
        workingSince: progress
          ? undefined
          : (pty.lastAgentStatusStartedAtEpochMs ?? row?.stateStartedAt),
        lastProducerEventAt: progress?.lastProducerEventAt,
        progressObservable: isAgentHookSource(agent) || progress !== undefined,
        tool:
          tool ??
          (row?.agentType === 'claude' && row.workingMode === 'monitoring'
            ? { name: 'background work', startedAt: row.stateStartedAt }
            : undefined)
      }
    })
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return [...workers.values()]
  }
  for (const sessionId of host.loadedSessionIds()) {
    if (host.readStatusSummary(sessionId)?.status !== 'working') {
      continue
    }
    const identity = resolveStructuredWorkerIdentityForSession(sessionId, db)
    if (identity) {
      const running = structuredWorkerSession(identity)
      if (running.kind !== 'here' || running.sessionId !== sessionId) {
        continue
      }
    }
    const progress = host.attentionReads.workerProgress(sessionId)
    if (!progress) {
      continue
    }
    const targets = chatWorkerDispatches(sessionId, db).map(({ dispatch, from }) => ({
      target: { kind: 'local', dispatch } as const,
      from
    }))
    for (const { target, from } of targets) {
      if (!target.dispatch.capability_revoked_at) {
        workers.set(target.dispatch.id, {
          target,
          from,
          agent: host.sessionAgent(sessionId) ?? 'agent',
          observation: { dispatchId: target.dispatch.id, working: true, ...progress }
        })
      }
    }
    if (!identity || targets.length) {
      continue
    }
    const attachment = db.findActiveRemoteAttachmentForPane(identity.paneKey)
    if (
      attachment &&
      db.isRemoteAttachmentProcessCurrent({
        dispatchId: attachment.dispatch_id,
        paneKey: identity.paneKey,
        processIncarnation: identity.processIncarnation
      })
    ) {
      workers.set(attachment.dispatch_id, {
        target: { kind: 'remote', attachment },
        from: identity.handle,
        agent: identity.agent ?? host.sessionAgent(sessionId) ?? 'agent',
        observation: { dispatchId: attachment.dispatch_id, working: true, ...progress }
      })
    }
  }
  return [...workers.values()]
}
