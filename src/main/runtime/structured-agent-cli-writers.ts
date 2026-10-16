import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'
import { getFreshShellForegroundSnapshot } from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { normalizeAgentProviderSession, type SleepingAgentSessionRecord } from '../../shared/agent-session-resume'

export type CliWriterPane = { ptyId: string; incarnationId: PtyIncarnationId; identity: string }
export type CliWriterHost = {
  rows: () => AgentStatusIpcPayload[]
  saved: () => SleepingAgentSessionRecord[]
  observation: (row: AgentStatusIpcPayload) => CliWriterObservation | null
  pane: (row: Pick<AgentStatusIpcPayload, 'paneKey' | 'worktreeId'>) => CliWriterPane | null
  sleeping: (workspaceId: string) => boolean
  shellAlone: (pane: CliWriterPane) => Promise<boolean>
}

/** Unlike foreground ownership, an empty subtree excludes background and suspended writers too. */
export async function posixCliWriterShellAlone(rootPid: number): Promise<boolean> {
  const index = getProcessTableIndex(await getFreshShellForegroundSnapshot())
  const root = index.byPid.get(rootPid)
  const executable = root?.command.trim().replace(/^-/, '').split(/\s+/, 1)[0] ?? ''
  return !!root && isShellProcess(executable) && root.stat.includes('+') &&
    collectDescendantsFromIndex(index, rootPid).length === 0
}

/** Execution-host observations release a terminal writer; loss of evidence never does. */
export async function assertCliConversationWritersExited(
  host: CliWriterHost,
  agent: StructuredAgentId,
  providerSessionId: string
): Promise<void> {
  const refuse = () =>
    agentSessionRefusalError('agent_session_conflict', { reason: 'conversationHeldElsewhere' })
  try {
    const savedCandidates = () => host.saved().filter((record) => !record.connectionId && adoptsCliConversations(record.agent) &&
      CLI_CONVERSATION_ADOPTING_AGENTS[record.agent] === agent &&
      normalizeAgentProviderSession(record.providerSession)?.id === providerSessionId)
    const saved = savedCandidates()
    const savedIdentity = (record: SleepingAgentSessionRecord) => [record.paneKey, record.worktreeId,
      record.connectionId, record.agent, record.providerSession.key, record.providerSession.id,
      record.providerSession.transcriptPath, record.capturedAt, record.updatedAt] as const
    const savedIdentities = new Map(saved.map((record) => [record, savedIdentity(record)] as const))
    const savedCurrent = (record: SleepingAgentSessionRecord) => savedCandidates().includes(record) &&
      savedIdentity(record).every((value, index) => value === savedIdentities.get(record)?.[index])
    const covered = new Map<SleepingAgentSessionRecord, () => boolean>()
    const rows = host.rows().filter(
      (row) => !row.connectionId && !row.structuredHost &&
        adoptsCliConversations(row.agentType) &&
        CLI_CONVERSATION_ADOPTING_AGENTS[row.agentType] === agent &&
        row.providerSession?.id === providerSessionId
    )
    for (const row of rows) {
      const matches = (record: SleepingAgentSessionRecord) => !record.connectionId && record.paneKey === row.paneKey &&
        record.worktreeId === row.worktreeId && record.agent === row.agentType &&
        record.providerSession.key === row.providerSession?.key && record.providerSession.id === row.providerSession?.id
      const matching = saved.filter(matches)
      const observed = host.observation(row)
      if (!observed || !observed.current() || observed.topology !== 'pane-owned' ||
        host.sleeping(row.worktreeId ?? '')) {
        throw refuse()
      }
      const pane = host.pane(row)
      const presence = await observed.presence()
      if (!observed.current() || presence === 'live' || presence === 'unverifiable' ||
        (pane && host.pane(row)?.identity !== pane.identity) || host.sleeping(row.worktreeId ?? '')) {
        throw refuse()
      }
      if (presence === 'exited' && matching.length === 0) {
        continue
      }
      if (!pane || !(await host.shellAlone(pane)) || !observed.current() ||
        host.pane(row)?.identity !== pane.identity || host.sleeping(row.worktreeId ?? '') ||
        matching.some((record) => !host.saved().includes(record) || !matches(record))) {
        throw refuse()
      }
      for (const record of matching) {
        covered.set(record, () => observed.current() && host.pane(row)?.identity === pane.identity &&
          !host.sleeping(row.worktreeId ?? '') && matches(record) && host.saved().includes(record))
      }
    }
    for (const [record, identity] of savedIdentities) {
      if (covered.has(record)) {
        continue
      }
      const [paneKey, worktreeId, , savedAgent] = identity
      if (savedAgent === 'opencode' || savedAgent === 'opencode2') {
        throw refuse()
      }
      const coordinates = { paneKey, worktreeId }
      const pane = host.pane(coordinates)
      if (!pane) {
        throw refuse()
      }
      const current = () => savedCurrent(record) && !host.sleeping(worktreeId) &&
        host.pane(coordinates)?.identity === pane.identity && !host.rows().some((row) => row.paneKey === paneKey)
      if (!current() || !(await host.shellAlone(pane)) || !current()) {
        throw refuse()
      }
      covered.set(record, current)
    }
    if ([...saved, ...savedCandidates()].some((record) => !savedCurrent(record) || !covered.get(record)?.())) {
      throw refuse()
    }
  } catch {
    throw refuse()
  }
}
