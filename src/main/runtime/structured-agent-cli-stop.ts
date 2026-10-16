import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessIdentity, AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { StructuredAgentSessionResumeSource } from '../../shared/structured-agent-session-create'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { CLI_CONVERSATION_ADOPTING_AGENTS, adoptsCliConversations } from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  captureDescendantSnapshot,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  readProcessTable,
  readProcessTableBeforeDeadline
} from '../pty-descendant-termination'
import { DESCENDANT_KILL_VERIFY_MS } from '../pty-descendant-exit-verification'
import { matchStructuredAgentCliSourceRow } from '../native-chat/structured-agent-cli-source'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessIdentityTableFresh
} from '../windows/windows-process-table'
import {
  windowsProcessStartTime,
  type PtyJobTerminationReport
} from '../windows/windows-pty-job-termination-report'

export type CliSourceStopHost = {
  rows: () => AgentStatusIpcPayload[]
  resolvePane: (paneKey: string, workspaceId: string) => { ptyId: string | null; connected?: boolean }
  sleeping: (workspaceId: string) => boolean
  presence: (paneKey: string) => Promise<AgentProcessVerdict | null>
  shellForeground: (ptyId: string) => Promise<boolean>
  rootPid: (ptyId: string) => Promise<number | null>
  stop: (workspaceId: string, ptyId: string) => Promise<{ postStopVerified: boolean }>
  /** Windows: ends the pane's job on its owner and lists every member it ended. */
  terminateJobAndReport: (ptyId: string) => Promise<PtyJobTerminationReport>
}

export type CliSourceStopRequest = {
  agent: StructuredAgentId
  resumeFrom: StructuredAgentSessionResumeSource
  workspaceId: string
}

export type CliSourceWriterInspection = {
  ptyId: string
  workspaceId: string
  writerMayLive: boolean
}

const conflict = () => agentSessionRefusalError('agent_session_conflict', {
  reason: 'conversationHeldElsewhere'
})
const unconfirmed = () => agentSessionRefusalError('agent_session_conflict', {
  reason: 'terminalStopUnconfirmed'
})

function matchingConversation(row: AgentStatusIpcPayload, input: CliSourceStopRequest): boolean {
  return (
    !row.connectionId &&
    !row.structuredHost &&
    adoptsCliConversations(row.agentType) &&
    CLI_CONVERSATION_ADOPTING_AGENTS[row.agentType] === input.agent &&
    row.providerSession?.id === input.resumeFrom.providerSessionId
  )
}

/** An old hook row is not proof of a live writer; a current PTY must answer for it. */
export async function inspectCliSourceWriters(
  host: CliSourceStopHost,
  input: CliSourceStopRequest
): Promise<CliSourceWriterInspection | null> {
  const rows = host.rows()
  const source = input.resumeFrom.cliSource
    ? matchStructuredAgentCliSourceRow({ ...input, rows })
    : null
  let sourcePtyId: string | null = null
  let sourceWriterMayLive = false
  for (const row of rows.filter((candidate) => matchingConversation(candidate, input))) {
    let pane: ReturnType<CliSourceStopHost['resolvePane']> | null = null
    try {
      pane = host.resolvePane(row.paneKey, row.worktreeId ?? '')
    } catch {
      // A sleeping pane can wake without a current PTY.
    }
    if (!pane?.ptyId || !pane.connected) {
      if (host.sleeping(row.worktreeId ?? '')) {
        throw conflict()
      }
      continue
    }
    const presence = await host.presence(row.paneKey).catch(() => 'unverifiable' as const)
    const shell = presence === 'exited'
      ? true
      : await host.shellForeground(pane.ptyId).catch(() => false)
    const writerMayLive = presence !== 'exited' && !shell
    if (writerMayLive && (row !== source || input.resumeFrom.cliSource?.stopRunningAgent !== true)) {
      throw conflict()
    }
    if (row === source) {
      sourcePtyId = pane.ptyId
      sourceWriterMayLive = writerMayLive
    }
  }
  if (!source) {
    return null
  }
  if (!sourcePtyId) {
    throw conflict()
  }
  return { ptyId: sourcePtyId, workspaceId: input.workspaceId, writerMayLive: sourceWriterMayLive }
}

/** The shell and every child are saved before stop, including children the PTY may orphan. */
export async function captureCliSourceProcessIdentities(
  host: CliSourceStopHost,
  ptyId: string
): Promise<AgentProcessIdentity[]> {
  const rootPid = await host.rootPid(ptyId).catch(() => null)
  if (!rootPid) {
    throw unconfirmed()
  }
  if (process.platform === 'win32') {
    // Why: only the job lists detached members, so reading it and ending it is one owner-side step.
    const report = await host.terminateJobAndReport(ptyId).catch(() => null)
    if (!report?.terminated) {
      throw unconfirmed()
    }
    return report.identities.map(({ pid, startTime }) => ({ pid, platform: 'win32', startTime }))
  }
  const snapshot = await captureDescendantSnapshot(rootPid)
  if (!snapshot?.root || snapshot.rootPgid === null) {
    throw unconfirmed()
  }
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw unconfirmed()
  }
  return [snapshot.root, ...snapshot.descendants].map((row) => ({
    pid: row.pid,
    platform,
    startTime: row.startedAt
  }))
}

/** Fresh whole-host rows keep reparented descendants probeable after the PTY closes. */
export async function probeCliSourceSurvivors(
  survivors: readonly AgentProcessIdentity[],
  platform: NodeJS.Platform = process.platform
): Promise<AgentProcessIdentity[]> {
  if (survivors.length === 0) {
    return []
  }
  if (platform === 'win32') {
    return probeWindowsCliSourceSurvivors(survivors)
  }
  const table = await readProcessTableBeforeDeadline(readProcessTable, DESCENDANT_SNAPSHOT_TIMEOUT_MS)
  if (!table) {
    return [...survivors]
  }
  const byPid = new Map(table.rows.map((row) => [row.pid, row.startedAt]))
  return survivors.filter((identity) =>
    identity.platform !== platform || byPid.get(identity.pid) === identity.startTime
  )
}

async function probeWindowsCliSourceSurvivors(
  survivors: readonly AgentProcessIdentity[]
): Promise<AgentProcessIdentity[]> {
  const table = isWindowsProcessStartTimeAvailable()
    ? await readWindowsProcessIdentityTableFresh().catch(() => null)
    : null
  if (!table) {
    return [...survivors]
  }
  const byPid = new Map(table.map((row) => [row.pid, row]))
  return survivors.filter((identity) => {
    if (identity.platform !== 'win32') {
      return true
    }
    const row = byPid.get(identity.pid)
    // A row without a creation time can't rule out the same process, so it stays a survivor.
    return (
      row !== undefined &&
      (row.creationTimeMs === undefined ||
        windowsProcessStartTime(row.creationTimeMs) === identity.startTime)
    )
  })
}

export async function stopCliSourceAndJudge(
  host: CliSourceStopHost,
  workspaceId: string,
  ptyId: string,
  identities: readonly AgentProcessIdentity[]
): Promise<AgentProcessIdentity[]> {
  const stopped = await host.stop(workspaceId, ptyId).catch((error: unknown) => ({
    // Why: on Windows the capture already ended the pane's whole job, so a pane already gone
    // is that stop; the survivor probe below still has to prove every member exited.
    postStopVerified:
      process.platform === 'win32' &&
      error instanceof Error &&
      error.message === 'terminal_stop_pty_set_mismatch'
  }))
  const deadline = Date.now() + DESCENDANT_KILL_VERIFY_MS
  let survivors = await probeCliSourceSurvivors(identities)
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    survivors = await probeCliSourceSurvivors(survivors)
  }
  return stopped.postStopVerified ? survivors : [...identities]
}
