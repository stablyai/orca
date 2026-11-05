import {
  agentReferenceNote,
  agentReferenceToken,
  isPublicOrchestrationAddress,
  mayHoldAgentReferences,
  printableAgentLabel,
  type OrchestrationAgentReference
} from '../../../../src/shared/orchestration-agent-reference'
import {
  CrewFrame,
  emptyCrew,
  type OrchestrationCrewRow,
  type OrchestrationCrewSnapshot
} from '../../../../src/shared/orchestration-crew'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../src/shared/agent-session/agent-session-message-source'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../src/shared/orca-session-address'
import { isMobileMethodUnavailableError } from '../../transport/mobile-method-unavailable'

export type MobileCrewStatus = 'running' | 'waiting' | 'done' | 'failed'

export type MobileCrewTab = {
  type: string
  sessionId?: string | null
  terminal?: string | null
}

const TOKEN = /@([^\n@]*?) \(Orca agent ([^)\n]+)\)/g

/** The desktop flag only mounts the desktop panel. The phone shows the pill when this host can answer the same subscription. */
export function mobileCrewParty(tab: MobileCrewTab | null): string | null {
  if (!tab) {
    return null
  }
  if (tab.type === 'terminal' && tab.terminal && isPublicOrchestrationAddress(tab.terminal)) {
    return tab.terminal
  }
  if (tab.sessionId && isOrcaSessionId(tab.sessionId)) {
    return formatOrcaSessionAddress(tab.sessionId)
  }
  return null
}

const OPEN_TASK = new Set(['pending', 'ready', 'dispatched', 'blocked', 'running', 'open'])

export function mobileCrewStatus(row: OrchestrationCrewRow): MobileCrewStatus {
  if (row.pendingQuestion || row.status === 'waiting' || row.status === 'blocked') {
    return 'waiting'
  }
  if (row.status === 'failed' || row.task?.state === 'failed' || row.task?.state === 'cancelled') {
    return 'failed'
  }
  // Running is live work only. An open dispatch whose agent is idle, including a host that stamped the last turn "done", is waiting.
  if (row.status === 'working' || row.status === 'monitoring') {
    return 'running'
  }
  if (
    (row.task && OPEN_TASK.has(row.task.state)) ||
    row.status === 'idle' ||
    row.status === 'unknown'
  ) {
    return 'waiting'
  }
  return 'done'
}

/** Desktop's second line is the latest status, not a repeat of the title. Drop it when that is all the host has. */
export function crewRowSubtitle(row: OrchestrationCrewRow, title: string): string | null {
  const line = (row.pendingQuestion?.preview || row.latest?.preview || '').trim()
  if (!line || line === title.trim()) {
    return null
  }
  return line
}

export function mobileCrewVisible(snapshot: OrchestrationCrewSnapshot): boolean {
  if (snapshot.status !== 'ok') {
    return false
  }
  const { managedBy, managing, talkingWith } = snapshot.sections
  return managedBy.length + managing.length + talkingWith.length > 0
}

export function mobileCrewRunningWorkers(snapshot: OrchestrationCrewSnapshot): number {
  return snapshot.sections.managing.filter((row) => mobileCrewStatus(row) === 'running').length
}

export function crewRowAddress(row: OrchestrationCrewRow): string | null {
  if (row.sendAddress && isPublicOrchestrationAddress(row.sendAddress)) {
    return row.sendAddress
  }
  const target = row.openTarget
  if (!target) {
    return null
  }
  if (target.kind === 'chat' && isOrcaSessionId(target.sessionId)) {
    return formatOrcaSessionAddress(target.sessionId)
  }
  if (target.kind === 'terminal' && isPublicOrchestrationAddress(target.handle)) {
    return target.handle
  }
  if (target.kind === 'dispatch' && isPublicOrchestrationAddress(target.address)) {
    return target.address
  }
  return null
}

export function crewMentionReference(
  row: OrchestrationCrewRow
): OrchestrationAgentReference | null {
  if (!row.sendAddress || !isPublicOrchestrationAddress(row.sendAddress)) {
    return null
  }
  return {
    label: printableAgentLabel(row.label) || 'Agent',
    address: row.sendAddress,
    hostKey: 'local'
  }
}

export function appendCrewMention(draft: string, row: OrchestrationCrewRow): string {
  const reference = crewMentionReference(row)
  if (!reference) {
    return draft
  }
  const token = agentReferenceToken(reference)
  const spacer = draft.length === 0 || /\s$/.test(draft) ? '' : ' '
  return `${draft}${spacer}${token} `
}

/** Desktop adds the routing note when the composer serializes a mention. The phone's plain draft does the same on send. */
export function projectMobileCrewMentions(text: string): string {
  if (!mayHoldAgentReferences(text)) {
    return text
  }
  const notes: string[] = []
  const seen = new Set<string>()
  const body = text.replace(TOKEN, (match, label: string, address: string) => {
    if (!isPublicOrchestrationAddress(address)) {
      return match
    }
    const clean = printableAgentLabel(label).trim() || 'Agent'
    if (!seen.has(address)) {
      seen.add(address)
      notes.push(agentReferenceNote(clean, address))
    }
    return `@${clean}`
  })
  if (notes.length === 0) {
    return text
  }
  return `${body.trimEnd()}\n\n${notes.join('\n')}`
}

export function crewOpenSender(row: OrchestrationCrewRow): {
  from: AgentMessageSource
  sender: AgentMessageSender
} | null {
  const address = crewRowAddress(row)
  if (!address) {
    return null
  }
  const sessionId = parseOrcaSessionAddress(address)
  const sender: AgentMessageSender = {
    party: {
      address,
      terminalHandle: address.startsWith('term_') ? address : null,
      orcaSessionId: sessionId
    },
    name: row.label,
    relation: row.role === 'manager' ? 'coordinator' : row.role === 'worker' ? 'worker' : 'none'
  }
  return {
    from: { kind: 'agent', senders: [sender], orchestration: null },
    sender
  }
}

export type CrewSubscriptionStep =
  | { kind: 'ignore'; pending: OrchestrationCrewSnapshot | null }
  | { kind: 'pending'; pending: OrchestrationCrewSnapshot }
  | { kind: 'snapshot'; snapshot: OrchestrationCrewSnapshot }
  | { kind: 'unsupported' }
  | { kind: 'ended' }

function failureKind(value: unknown): 'unsupported' | 'ended' | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'error') {
    return null
  }
  const error =
    'error' in value && value.error && typeof value.error === 'object' ? value.error : null
  const code = error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message =
    (error && 'message' in error && typeof error.message === 'string'
      ? error.message
      : undefined) ??
    ('message' in value && typeof value.message === 'string' ? value.message : undefined)
  if (
    isMobileMethodUnavailableError(code, message) ||
    code === 'unsupported_method' ||
    message?.includes('unsupported_method') === true ||
    message?.includes('Unknown method') === true
  ) {
    return 'unsupported'
  }
  return 'ended'
}

export function reduceCrewSubscription(
  pending: OrchestrationCrewSnapshot | null,
  value: unknown
): CrewSubscriptionStep {
  const failure = failureKind(value)
  if (failure) {
    return { kind: failure }
  }
  const parsed = CrewFrame.safeParse(value)
  if (!parsed.success) {
    return { kind: 'ignore', pending }
  }
  const frame = parsed.data
  if (frame.type === 'begin') {
    return { kind: 'pending', pending: emptyCrew(frame.status) }
  }
  if (frame.type === 'rows') {
    if (!pending) {
      return { kind: 'ignore', pending }
    }
    const next: OrchestrationCrewSnapshot = {
      status: pending.status,
      sections: {
        managedBy: [...pending.sections.managedBy],
        managing: [...pending.sections.managing],
        talkingWith: [...pending.sections.talkingWith]
      }
    }
    next.sections[frame.section].push(...frame.rows)
    return { kind: 'pending', pending: next }
  }
  if (frame.type === 'complete' && pending) {
    return { kind: 'snapshot', snapshot: pending }
  }
  if (frame.type === 'end') {
    return { kind: 'ended' }
  }
  return { kind: 'ignore', pending }
}
