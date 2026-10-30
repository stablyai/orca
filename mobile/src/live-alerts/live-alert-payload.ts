import { toHostSessionPaneKey } from '../../../src/shared/terminal-surface-id'
import {
  STATUS_TEXT_MAX,
  SUB_TEXT_MAX,
  agentLabel,
  finishedLine,
  rawWorkingLine,
  truncateStatusText,
  waitingLine
} from './live-agent-status-text'
import { isActiveLiveAgent, lastFinishedAgent, primaryLiveAgent } from './live-agent-summary'
import type { LiveAgent, LiveAlertPayload, LiveAlertTarget } from './live-alert-types'

// Status-bar chip words: 7 characters or fewer, so the 96 dp chip shows them whole.
export const CHIP_WORKING = 'Working'
export const CHIP_APPROVE = 'Approve'
export const CHIP_REPLY = 'Reply'
export const CHIP_DONE = 'Done'
export const CHIP_STOPPED = 'Stopped'
export const CHIP_OFFLINE = 'Offline'

const WORKSPACE_MAX = 28
const HOST_NAME_MAX = 18

export type LivePayloadInput = {
  startedAt: number
  /** Every agent seen active since the session started. */
  sessionKeys: ReadonlySet<string>
  /** The agents read from hosts whose data is current. */
  agents: readonly LiveAgent[]
}

/** Where a tap on the notification opens: the agent's session, as push taps do. */
export function liveAlertTarget(agent: LiveAgent): LiveAlertTarget {
  return {
    hostId: agent.hostId,
    worktreeId: agent.worktreeId,
    paneKey: toHostSessionPaneKey(agent.paneKey),
    ...(agent.executionHost ? { executionHost: agent.executionHost } : {})
  }
}

function sessionAgents(input: LivePayloadInput): LiveAgent[] {
  return input.agents.filter((agent) => input.sessionKeys.has(agent.key))
}

function spansHosts(agents: readonly LiveAgent[]): boolean {
  return new Set(agents.map((agent) => agent.hostId)).size > 1
}

// "{agent} · {workspace}", plus the desktop when agents run on several, plus "+k more".
function subTextFor(agent: LiveAgent, withHost: boolean, others: number): string {
  const parts = [agentLabel(agent.agentType), truncateStatusText(agent.workspace, WORKSPACE_MAX)]
  if (withHost) {
    parts.push(truncateStatusText(agent.hostName, HOST_NAME_MAX))
  }
  if (others > 0) {
    parts.push(`+${others} more`)
  }
  return truncateStatusText(parts.join(' · '), SUB_TEXT_MAX)
}

function liveTitle(waiting: readonly LiveAgent[], working: number): string {
  if (waiting.length === 1) {
    return waiting[0].need === 'approval' ? 'Needs your approval' : 'Needs your input'
  }
  if (waiting.length > 1) {
    return `${waiting.length} agents need you`
  }
  return working === 1 ? 'Agent working' : `${working} agents working`
}

function liveChip(primary: LiveAgent): string {
  if (primary.phase !== 'waiting') {
    return CHIP_WORKING
  }
  return primary.need === 'approval' ? CHIP_APPROVE : CHIP_REPLY
}

function finishedTitle(done: number, stopped: number): string {
  if (stopped === 0) {
    return done > 1 ? `${done} agents done` : 'Done'
  }
  if (done === 0) {
    return stopped > 1 ? `${stopped} agents stopped` : 'Agent stopped'
  }
  return `${done} done, ${stopped} stopped`
}

/** The ongoing notification while at least one agent works or waits; null when none does. */
export function buildLivePayload(input: LivePayloadInput): LiveAlertPayload | null {
  const active = input.agents.filter(isActiveLiveAgent)
  const primary = primaryLiveAgent(active)
  if (!primary) {
    return null
  }
  const waiting = active.filter((agent) => agent.phase === 'waiting')
  const total = Math.max(input.sessionKeys.size, active.length)
  const text = primary.phase === 'waiting' ? waitingLine(primary) : rawWorkingLine(primary)
  return {
    phase: primary.phase === 'waiting' ? 'waiting' : 'working',
    title: liveTitle(waiting, active.length - waiting.length),
    text: truncateStatusText(text, STATUS_TEXT_MAX),
    subText: subTextFor(primary, spansHosts(sessionAgents(input)), active.length - 1),
    chipText: liveChip(primary),
    startedAt: input.startedAt,
    progressFinished: total >= 2 ? total - active.length : null,
    progressTotal: total >= 2 ? total : null,
    indeterminate: total < 2 && primary.phase === 'working',
    targetJson: JSON.stringify(liveAlertTarget(primary))
  }
}

function buildFinishedPayload(
  input: LivePayloadInput,
  phase: 'lingering' | 'final'
): LiveAlertPayload {
  const session = sessionAgents(input)
  const done = session.filter((agent) => agent.phase === 'done').length
  const stopped = session.filter((agent) => agent.phase === 'failed' || agent.phase === 'stopped')
  const last = lastFinishedAgent(session)
  const total = input.sessionKeys.size
  const text = last ? finishedLine(last) : 'Finished'
  return {
    phase,
    title: finishedTitle(done, stopped.length),
    text: truncateStatusText(text, STATUS_TEXT_MAX),
    subText: last ? subTextFor(last, spansHosts(session), 0) : null,
    chipText: phase === 'lingering' ? lingerChip(done, stopped.length) : null,
    startedAt: input.startedAt,
    progressFinished: total >= 2 ? total : null,
    progressTotal: total >= 2 ? total : null,
    indeterminate: false,
    targetJson: last ? JSON.stringify(liveAlertTarget(last)) : null
  }
}

function lingerChip(done: number, stopped: number): string {
  return done === 0 && stopped > 0 ? CHIP_STOPPED : CHIP_DONE
}

/** Still ongoing for a few seconds after the last agent finished, so the result is seen. */
export function buildLingerPayload(input: LivePayloadInput): LiveAlertPayload {
  return buildFinishedPayload(input, 'lingering')
}

/** The dismissable notification left behind when the session ends. */
export function buildFinalPayload(input: LivePayloadInput): LiveAlertPayload {
  return buildFinishedPayload(input, 'final')
}

/** No fresh rows from the desktop while agents were running there. */
export function buildDisconnectedPayload(
  startedAt: number,
  phase: 'working' | 'final'
): LiveAlertPayload {
  return {
    phase,
    title: 'Disconnected',
    text: 'Lost connection to your desktop',
    subText: null,
    chipText: phase === 'final' ? null : CHIP_OFFLINE,
    startedAt,
    progressFinished: null,
    progressTotal: null,
    indeterminate: false,
    targetJson: null
  }
}
