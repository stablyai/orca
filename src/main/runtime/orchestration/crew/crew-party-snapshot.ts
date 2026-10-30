import { crewRecipientAvailability } from './crew-recipient-availability'
import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import {
  emptyCrew,
  type OrchestrationCrewSnapshot,
  type OrchestrationCrewRow
} from '../../../../shared/orchestration-crew'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration-fleet-agent-status-evidence'
import { isPublicOrchestrationAddress } from '../../../../shared/orchestration-agent-reference'
import type { OrchestrationDb } from '../db'
import {
  createLineageRunningSessionResolver,
  type AgentSessionRecordReader
} from '../structured-session-lineage'
import { crewDisplayName, crewTaskDisplay } from './crew-rules'
import {
  readCrewOwnedRunAddresses,
  readCrewQuestions,
  readCrewTraffic,
  type CrewAssignmentRow
} from './crew-query'

import type { Party } from './crew-parties'
import { crewParentRelations } from './crew-parent-relations'
import { createCrewHostDerivation } from './crew-host-derivation'
import { statusForFleetWorker } from '../../../../shared/orchestration-fleet-status-index'
import { projectLiveness } from '../../../../shared/orchestration-fleet-worker-projection'
import { federatedMessageNamesOnlyHome } from '../dispatch-report-mailbox'
import { workerReportRefusal } from '../worker-report-admission'
import { isEquivalentPaneKey } from '../db/pane-key-match'
export type CrewReadDependencies = {
  db: OrchestrationDb | null
  retainedDbExists: boolean
  hostKey: string
  records: AgentSessionRecordReader | null
  liveHandle: (handle: string) => boolean
  handleForPane: (pane: string) => string | null
  paneForHandle: (handle: string) => string | null
  name: (
    party: AgentMessageSender['party'],
    taskName: string | null,
    records: AgentSessionRecordReader | null
  ) => string | null
  callerPaneForHandle?: (handle: string) => string | null
  livePaneForHandle?: (handle: string) => string | null
  processForHandle?: (handle: string) => string | null
  statuses: readonly FleetAgentStatusEvidence[]
  now?: number
  openIdentityRead?: () => CrewIdentityRead
  openRuntimeIdentityRead?: () => TerminalIdentityReadContext
}

export type CrewIdentityRead = Pick<
  CrewReadDependencies,
  | 'liveHandle'
  | 'handleForPane'
  | 'paneForHandle'
  | 'processForHandle'
  | 'callerPaneForHandle'
  | 'livePaneForHandle'
  | 'name'
>

function preview(body: string): string {
  const bytes = Buffer.from(body)
  return bytes.length <= 1024
    ? body
    : `${bytes
        .subarray(0, 1021)
        .toString('utf8')
        .replace(/\uFFFD$/, '')}…`
}

export function buildCrewSnapshot(
  address: string,
  deps: CrewReadDependencies,
  host = createCrewHostDerivation(deps, deps.now ?? Date.now())
): OrchestrationCrewSnapshot {
  deps = { ...host.deps, now: deps.now }
  const db = deps.db
  if (!db) {
    return emptyCrew(deps.retainedDbExists ? 'unknown' : 'ok')
  }
  const now = deps.now ?? Date.now()
  const cutoff = new Date(now - AGENT_STATUS_STALE_AFTER_MS).toISOString()
  const identity = deps.openIdentityRead?.()
  if (identity) {
    deps = { ...deps, ...identity }
  }
  const registry = host.registry.fork(identity)
  const { party, alias, addressOf, getParty, aliasesFor } = registry
  const records = host.deps.records
  const runningSession = createLineageRunningSessionResolver(records)
  const hydrate = (addresses: string[], panes: string[] = []) => {
    const provenance = host.sourceInputs.provenance(addresses, panes)
    for (const family of [provenance.local, provenance.remote]) {
      for (const row of family) {
        const worker = party(row.session, row.handle, row.pane, `dispatch:${row.id}`, row.process)
        if (worker) {
          alias(`dispatch:${row.id}`, worker.address)
        }
      }
    }
  }
  const rawSession = parseOrcaSessionAddress(address)
  let self = party(
    rawSession,
    rawSession ? null : address,
    rawSession ? null : deps.paneForHandle(address),
    address
  )
  if (!self) {
    return emptyCrew('unknown')
  }
  hydrate(aliasesFor(self.address), self.paneKey ? [self.paneKey] : [])
  self = getParty(addressOf(self.address) ?? self.address) ?? self
  const remoteAttachment = self.paneKey
    ? host.sourceInputs.activeRemoteAttachmentForPane(self.paneKey)
    : undefined
  const canAddressPeer = (to: string | undefined) =>
    !remoteAttachment ||
    (to !== undefined &&
      federatedMessageNamesOnlyHome({ to }, remoteAttachment.run) &&
      !workerReportRefusal({
        dispatchId: remoteAttachment.id,
        from: self.address,
        workerState: remoteAttachment.remoteRoute?.stopping ? 'stopping' : undefined,
        processCurrent: Boolean(
          remoteAttachment.pane &&
          self.paneKey &&
          isEquivalentPaneKey(remoteAttachment.pane, self.paneKey) &&
          remoteAttachment.process &&
          self.terminalHandle &&
          remoteAttachment.process === deps.processForHandle?.(self.terminalHandle)
        )
      }))
  const ownedRunAddresses = readCrewOwnedRunAddresses(db, self, host.sourceInputs.legacyOwner())
  for (const current of host.sourceInputs.runInputs(ownedRunAddresses)) {
    const coordinator = party(current.session, current.handle, current.pane, `run:${current.id}`)
    if (coordinator) {
      alias(`run:${current.id}`, coordinator.address)
    }
  }
  const selfAliases = () => aliasesFor(self.address)
  const traffic = readCrewTraffic(db, selfAliases(), cutoff)
  hydrate(traffic.map((message) => message.peer))
  for (const run of host.sourceInputs.runInputs(traffic.map((message) => message.peer))) {
    const coordinator = party(run.session, run.handle, run.pane, `run:${run.id}`)
    if (coordinator) {
      alias(`run:${run.id}`, coordinator.address)
    }
  }
  const rows = new Map<string, OrchestrationCrewRow>()
  const decorate = (
    target: Party,
    role: OrchestrationCrewRow['role'],
    assignment?: CrewAssignmentRow,
    sendAddress?: string
  ): OrchestrationCrewRow => {
    const display = crewTaskDisplay(assignment)
    const title = display.taskTitle || display.displayName
    const live = target.orcaSessionId ? runningSession(target.orcaSessionId) : null
    const worker = assignment ? host.workersById.get(assignment.id) : undefined
    const evidence =
      worker && !target.orcaSessionId
        ? statusForFleetWorker(worker, host.statusIndex)
        : target.paneKey
          ? host.statusesByPane.get(target.paneKey)
          : undefined
    const bound =
      evidence &&
      (live?.kind === 'here' ||
        Boolean(worker) ||
        (evidence.binding.kind !== 'unresolved' &&
          evidence.binding.terminalHandle === target.terminalHandle &&
          evidence.binding.paneKey === target.paneKey &&
          (evidence.binding.kind !== 'worker' || evidence.binding.dispatchId === assignment?.id)))
    const fresh =
      bound && projectLiveness({ resource: null }, evidence, now).verdict === 'live'
        ? evidence
        : undefined
    const row: OrchestrationCrewRow = {
      partyKey: JSON.stringify([deps.hostKey, target.address]),
      role,
      label: crewDisplayName(
        deps.name(target, display.displayName || display.taskTitle || null, records),
        title,
        'Agent'
      )!,
      agentKind:
        live?.kind === 'here'
          ? live.record.provider
          : (fresh?.activity.agentType ?? assignment?.agent ?? 'Agent'),
      status:
        fresh?.activity.state ??
        (assignment
          ? ['pending', 'dispatched'].includes(assignment.status)
            ? 'working'
            : 'done'
          : 'unknown'),
      ...(title && assignment ? { task: { title, state: assignment.task_status } } : {}),
      ...(assignment?.stage && !['accepted', 'ready'].includes(assignment.stage)
        ? { progress: assignment.stage.replaceAll('_', ' ') }
        : {}),
      ...(assignment?.host_label ? { hostLabel: assignment.host_label } : {}),
      ...(sendAddress && isPublicOrchestrationAddress(sendAddress) ? { sendAddress } : {})
    }
    if (live?.kind === 'here') {
      row.openTarget = {
        kind: 'chat',
        sessionId: live.sessionId,
        worktreeId: live.record.location.workspaceId
      }
    } else if (target.terminalHandle) {
      row.openTarget = { kind: 'terminal', handle: target.terminalHandle }
    } else if (assignment && !assignment.host_label) {
      row.openTarget = { kind: 'dispatch', address: `dispatch:${assignment.id}` }
    }
    rows.set(target.address, row)
    return row
  }
  const snapshot = emptyCrew('ok')
  for (const { assignment, worker, parent } of host.relations.get(self.address) ?? []) {
    if (parent.address === self.address) {
      snapshot.sections.managing.push(
        decorate(worker, 'worker', assignment, `dispatch:${assignment.id}`)
      )
    }
  }
  const parents = host.sourceInputs.parentInputs(selfAliases(), self.paneKey ? [self.paneKey] : [])
  for (const relation of crewParentRelations(parents, self, registry, deps)) {
    const row = decorate(relation.parent, 'manager', relation.assignment, relation.address)
    row.partyKey = relation.key
    snapshot.sections.managedBy.push(row)
  }
  const selectedTraffic = traffic.flatMap((message) => {
    let targetAddress = addressOf(message.peer)
    if (!targetAddress) {
      const parsed = parseOrcaSessionAddress(message.peer)
      targetAddress = party(parsed, parsed ? null : message.peer, null, message.peer)?.address
    }
    if (!targetAddress || targetAddress === self.address) {
      return []
    }
    return [{ message, target: getParty(targetAddress)! }]
  })
  const sessionPeers = [
    ...new Set(
      selectedTraffic.flatMap(({ target }) =>
        target.orcaSessionId && !rows.has(target.address) && canAddressPeer(target.address)
          ? [target.orcaSessionId]
          : []
      )
    )
  ]
  const available = crewRecipientAvailability(host, self, sessionPeers, deps)
  for (const { message, target } of selectedTraffic) {
    const targetAddress = target.address
    let row = rows.get(targetAddress)
    if (!row) {
      const sendAddress = target.orcaSessionId
        ? target.address
        : (target.terminalHandle ??
          (target.address.startsWith('dispatch:') || target.address.startsWith('run:')
            ? target.address
            : undefined))
      row = decorate(
        target,
        'peer',
        undefined,
        canAddressPeer(sendAddress) &&
          (!target.orcaSessionId || available?.(target.orcaSessionId) === true)
          ? sendAddress
          : undefined
      )
      snapshot.sections.talkingWith.push(row)
    }
    if (!row.latest || message.sequence > row.latest.sequence) {
      row.latest = {
        direction: message.direction,
        preview: preview(message.body),
        at: message.created_at,
        sequence: message.sequence
      }
    }
  }
  const questions = readCrewQuestions(db, selfAliases())
  for (const question of questions) {
    const target = addressOf(`dispatch:${question.dispatch_id}`)
    const row = target ? rows.get(target) : undefined
    if (row && !row.pendingQuestion) {
      row.pendingQuestion = { preview: preview(question.body), at: question.created_at }
    }
  }
  return snapshot
}
