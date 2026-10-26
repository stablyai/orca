import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import {
  adoptsCliConversations,
  chatAgentsShareConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'
import { getFreshShellForegroundSnapshot } from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import {
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'

export type CliWriterPane = { ptyId: string; incarnationId: PtyIncarnationId; identity: string }
type CliWriterCoordinates = { paneKey: string; worktreeId?: string }
/** `pane` is null when the PTY can't be inspected: remote, WSL, disconnected or unresolvable. */
export type CliWriterTerminal = { pane: CliWriterPane | null }
/** A conversation one PTY execution reported; `process` is the agent the hooks last proved. */
export type CliWriterConversation = {
  agent: string
  id: string
  paneOwned: boolean
  process?: AgentProcessIdentity
}
export type CliWriterLink = CliWriterConversation & {
  worktreeId: string
  terminal: () => CliWriterTerminal | null
}
export type CliWriterHost = {
  rows: () => AgentStatusIpcPayload[]
  saved: () => SleepingAgentSessionRecord[]
  observation: (row: AgentStatusIpcPayload) => CliWriterObservation | null
  /** Null when nothing in the pane can still write: no PTY, or one whose exit was certified. */
  terminal: (pane: CliWriterCoordinates) => CliWriterTerminal | null
  /** Conversations each live PTY's current execution reported, outliving the rows that named them. */
  links: () => CliWriterLink[]
  sleeping: (workspaceId: string) => boolean
  shellAlone: (pane: CliWriterPane) => Promise<boolean>
}

/** Unlike foreground ownership, any job left in the shell's session refuses, background and suspended too. */
export async function posixCliWriterShellAlone(rootPid: number): Promise<boolean> {
  const index = getProcessTableIndex(await getFreshShellForegroundSnapshot())
  const root = index.byPid.get(rootPid)
  const executable = root?.command.trim().replace(/^-/, '').split(/\s+/, 1)[0] ?? ''
  return (
    !!root &&
    isShellProcess(executable) &&
    root.stat.includes('+') &&
    // A session leader below the shell has left this terminal (a prompt's zpty worker); its jobs never do.
    collectDescendantsFromIndex(index, rootPid, (row) => row.stat.includes('s')).length === 0
  )
}

/** Execution-host observations release a terminal writer; loss of evidence never does. */
export async function assertCliConversationWritersExited(
  host: CliWriterHost,
  agent: StructuredAgentId,
  providerSessionId: string,
  source?: CliWriterCoordinates
): Promise<void> {
  const refuse = () =>
    agentSessionRefusalError('agent_session_conflict', { reason: 'conversationHeldElsewhere' })
  const isConversation = (rowAgent: unknown, id: string | undefined) =>
    adoptsCliConversations(rowAgent) &&
    CLI_CONVERSATION_ADOPTING_AGENTS[rowAgent].some((rowChat) =>
      chatAgentsShareConversations(rowChat, agent)
    ) &&
    id === providerSessionId
  const proofs: (() => boolean)[] = []
  const paneOf = (coordinates: CliWriterCoordinates) => host.terminal(coordinates)?.pane ?? null
  // The pane's PTY itself, not a recorded pid: a wrapper pid can read exited beside a paused agent.
  const censusPane = async (
    read: () => CliWriterTerminal | null,
    worktreeId: string | undefined,
    absentAdmits: boolean
  ) => {
    const terminal = read()
    if (!terminal && absentAdmits) {
      proofs.push(() => !read())
      return
    }
    const pane = terminal?.pane
    if (
      !pane ||
      host.sleeping(worktreeId ?? '') ||
      !(await host.shellAlone(pane)) ||
      read()?.pane?.identity !== pane.identity
    ) {
      throw refuse()
    }
    proofs.push(() => !host.sleeping(worktreeId ?? '') && read()?.pane?.identity === pane.identity)
  }
  try {
    if (source) {
      await censusPane(() => host.terminal(source), source.worktreeId, true)
    }
    const savedCandidates = () =>
      host
        .saved()
        .filter(
          (record) =>
            !record.connectionId &&
            isConversation(record.agent, normalizeAgentProviderSession(record.providerSession)?.id)
        )
    const saved = savedCandidates()
    const savedIdentity = (record: SleepingAgentSessionRecord) =>
      [
        record.paneKey,
        record.worktreeId,
        record.connectionId,
        record.agent,
        record.providerSession.key,
        record.providerSession.id,
        record.providerSession.transcriptPath,
        record.capturedAt,
        record.updatedAt
      ] as const
    const savedIdentities = new Map(saved.map((record) => [record, savedIdentity(record)] as const))
    const savedCurrent = (record: SleepingAgentSessionRecord) =>
      savedCandidates().includes(record) &&
      savedIdentity(record).every((value, index) => value === savedIdentities.get(record)?.[index])
    const covered = new Map<SleepingAgentSessionRecord, () => boolean>()
    const rows = host
      .rows()
      .filter(
        (row) =>
          !row.connectionId &&
          !row.structuredHost &&
          isConversation(row.agentType, row.providerSession?.id)
      )
    for (const row of rows) {
      const matches = (record: SleepingAgentSessionRecord) =>
        !record.connectionId &&
        record.paneKey === row.paneKey &&
        record.worktreeId === row.worktreeId &&
        record.agent === row.agentType &&
        record.providerSession.key === row.providerSession?.key &&
        record.providerSession.id === row.providerSession?.id
      const matching = saved.filter(matches)
      const observed = host.observation(row)
      if (!observed || !observed.current()) {
        throw refuse()
      }
      proofs.push(() => observed.current())
      const pane = paneOf(row)
      const presence = await observed.presence()
      if (
        !observed.current() ||
        presence === 'live' ||
        presence === 'unverifiable' ||
        (pane && paneOf(row)?.identity !== pane.identity)
      ) {
        throw refuse()
      }
      if (!host.terminal(row)) {
        proofs.push(() => !host.terminal(row))
        if (row.agentType !== 'opencode' && row.agentType !== 'opencode2') {
          for (const record of matching) {
            covered.set(
              record,
              () => savedCurrent(record) && observed.current() && !host.terminal(row)
            )
          }
        }
        continue
      }
      if (observed.topology !== 'pane-owned' || host.sleeping(row.worktreeId ?? '')) {
        throw refuse()
      }
      if (presence === 'exited' && matching.length === 0) {
        await censusPane(() => host.terminal(row), row.worktreeId, true)
        if (!observed.current()) {
          throw refuse()
        }
        continue
      }
      if (
        !pane ||
        !(await host.shellAlone(pane)) ||
        !observed.current() ||
        paneOf(row)?.identity !== pane.identity ||
        host.sleeping(row.worktreeId ?? '') ||
        matching.some((record) => !host.saved().includes(record) || !matches(record))
      ) {
        throw refuse()
      }
      const current = () =>
        paneOf(row)?.identity === pane.identity && !host.sleeping(row.worktreeId ?? '')
      proofs.push(current)
      for (const record of matching) {
        covered.set(record, () => current() && savedCurrent(record) && matches(record))
      }
    }
    for (const link of host.links()) {
      if (!isConversation(link.agent, link.id)) {
        continue
      }
      // The agent can outlive the terminal's tree (detached tmux, nohup); its probe only adds refusals.
      if (
        !link.paneOwned ||
        (link.process && (await probeAgentProcessPresence(link.process)) !== 'exited')
      ) {
        throw refuse()
      }
      await censusPane(link.terminal, link.worktreeId, false)
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
      const terminal = host.terminal(coordinates)
      if (!terminal) {
        covered.set(record, () => savedCurrent(record) && !host.terminal(coordinates))
        continue
      }
      const pane = terminal.pane
      if (!pane) {
        throw refuse()
      }
      const current = () =>
        savedCurrent(record) &&
        !host.sleeping(worktreeId) &&
        paneOf(coordinates)?.identity === pane.identity &&
        !host.rows().some((row) => row.paneKey === paneKey)
      if (!current() || !(await host.shellAlone(pane)) || !current()) {
        throw refuse()
      }
      covered.set(record, current)
    }
    if (
      proofs.some((current) => !current()) ||
      [...saved, ...savedCandidates()].some(
        (record) => !savedCurrent(record) || !covered.get(record)?.()
      )
    ) {
      throw refuse()
    }
  } catch {
    throw refuse()
  }
}
