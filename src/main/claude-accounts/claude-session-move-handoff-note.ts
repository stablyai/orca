import type { AgentSubagentSnapshot } from '../../shared/agent-status/contracts/agent-status-subagent-snapshot'
import type { AgentWorkingMode } from '../../shared/agent-status/contracts/agent-status-types'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { stripTerminalControl } from '../../shared/terminal/protocol/escape/terminal-control-stripping'

export type ClaudeSessionDetachedJob = {
  state: string
  id: string
  logPath: string
  sessionId?: string
}

/** Same sentences as the durable-job script. Kept here so this note compiles when that script is absent. */
export function formatSurvivingJobNote(
  jobs: readonly { state: string; id: string; logPath: string }[]
): string {
  const running = jobs.filter((job) => job.state === 'running')
  if (running.length === 0) {
    return 'No detached Orca jobs were still running.'
  }
  const details = running.map((job) => `${job.id} log=${job.logPath}`).join('; ')
  return `Detached Orca jobs still running after this restart: ${details}.`
}

/** Jobs whose request.json names this Claude session. */
export function detachedJobsForSession(
  sessionId: string,
  jobs: readonly ClaudeSessionDetachedJob[]
): ClaudeSessionDetachedJob[] {
  return jobs.filter((job) => job.sessionId === sessionId)
}

/** What the pre-move hook row knew about work the restart will kill. */
export type ClaudeSessionMoveEndedWork = {
  workingMode?: AgentWorkingMode
  claudeRunningNonAgentTask?: boolean
  subagents: {
    id: string
    agentType?: string
    state: AgentSubagentSnapshot['state']
  }[]
}

export type ClaudeSessionMoveHandoffTranslate = (
  key: string,
  fallback: string,
  options?: Record<string, string | number>
) => string

const ENDED_SUBAGENT_LIMIT = 12

export function emptyClaudeSessionMoveEndedWork(): ClaudeSessionMoveEndedWork {
  return { subagents: [] }
}

export function captureClaudeSessionMoveEndedWork(
  source:
    | {
        workingMode?: AgentWorkingMode
        claudeRunningNonAgentTask?: boolean
        subagents?: readonly Pick<AgentSubagentSnapshot, 'id' | 'agentType' | 'state'>[]
      }
    | null
    | undefined
): ClaudeSessionMoveEndedWork {
  const subagents: ClaudeSessionMoveEndedWork['subagents'] = []
  for (const subagent of source?.subagents ?? []) {
    if (subagent.id.length === 0) {
      continue
    }
    subagents.push({
      id: subagent.id,
      state: subagent.state,
      ...(subagent.agentType ? { agentType: subagent.agentType } : {})
    })
  }
  const activeFirst = subagents.sort(
    (a, b) => Number(a.state === 'idle') - Number(b.state === 'idle')
  )
  return {
    ...(source?.workingMode ? { workingMode: source.workingMode } : {}),
    ...(source?.claudeRunningNonAgentTask !== undefined
      ? { claudeRunningNonAgentTask: source.claudeRunningNonAgentTask }
      : {}),
    subagents: activeFirst
  }
}

function fill(template: string, options: Record<string, string | number> | undefined): string {
  if (!options) {
    return template
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = options[name]
    return value === undefined ? match : String(value)
  })
}

function text(
  translate: ClaudeSessionMoveHandoffTranslate,
  key: string,
  fallback: string,
  options?: Record<string, string | number>
): string {
  return fill(translate(key, fallback, options), options)
}

function describeEndedWork(
  ended: ClaudeSessionMoveEndedWork,
  translate: ClaudeSessionMoveHandoffTranslate
): string {
  const parts: string[] = []
  if (ended.workingMode === 'monitoring') {
    parts.push(text(translate, 'accounts.claude.sessionMover.handoff.monitoring', 'monitoring'))
  }
  if (ended.claudeRunningNonAgentTask) {
    parts.push(
      text(
        translate,
        'accounts.claude.sessionMover.handoff.backgroundTask',
        'a background task was still running'
      )
    )
  }
  const shown = ended.subagents.slice(0, ENDED_SUBAGENT_LIMIT)
  for (const subagent of shown) {
    parts.push(
      subagent.agentType
        ? text(
            translate,
            'accounts.claude.sessionMover.handoff.subagent',
            '{{agentType}} {{id}} ({{state}})',
            { agentType: subagent.agentType, id: subagent.id, state: subagent.state }
          )
        : text(
            translate,
            'accounts.claude.sessionMover.handoff.subagentUntyped',
            '{{id}} ({{state}})',
            { id: subagent.id, state: subagent.state }
          )
    )
  }
  const hidden = ended.subagents.length - shown.length
  if (hidden > 0) {
    parts.push(
      text(translate, 'accounts.claude.sessionMover.handoff.more', 'and {{count}} more', {
        count: hidden
      })
    )
  }
  if (parts.length === 0) {
    return text(translate, 'accounts.claude.sessionMover.handoff.none', 'none reported')
  }
  return parts.join('; ')
}

/** One prompt for the resumed session. Placeholders are filled even when i18n is not initialized. */
export function buildClaudeSessionMoveHandoffNote(
  input: {
    fromEmail: string
    toEmail: string
    detail: string
    endedWork: ClaudeSessionMoveEndedWork
    detachedJobs?: readonly ClaudeSessionDetachedJob[]
  },
  translate: ClaudeSessionMoveHandoffTranslate
): string {
  const detail =
    input.detail.trim() ||
    text(translate, 'accounts.claude.sessionMover.handoff.detailFallback', 'its usage limit')
  const known = describeEndedWork(input.endedWork, translate)
  const surviving = formatSurvivingJobNote(input.detachedJobs ?? [])
  return [
    text(
      translate,
      'accounts.claude.sessionMover.handoff.moved',
      'Orca moved this session from {{from}} to {{to}} because {{detail}}.',
      { from: input.fromEmail, to: input.toEmail, detail }
    ),
    text(
      translate,
      'accounts.claude.sessionMover.handoff.ended',
      'The restart ended subagents of the previous process ({{known}}).',
      { known }
    ),
    surviving,
    text(
      translate,
      'accounts.claude.sessionMover.handoff.continue',
      'Re-run what is still needed, then continue.'
    )
  ].join(' ')
}

function lastVisibleLine(screen: string): string {
  const lines = stripTerminalControl(screen)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? ''
}

/** A shell prompt must never receive the note, including one drawn after Claude exits. */
export function claudeResumeScreenIsShellPrompt(screen: string): boolean {
  const line = lastVisibleLine(screen)
  // `$`/`#` sit on a path boundary (`user@host:~$`). `%` needs whitespace so `96%` is not a prompt.
  if (/(?:^|[\s:~/])[$#]\s*$/.test(line) || /(?:^|\s)%\s*$/.test(line)) {
    return true
  }
  const promptMark = screen.lastIndexOf('\u001b]133;A')
  if (promptMark === -1) {
    return false
  }
  return !screen.slice(promptMark).includes('❯\u00a0')
}

/** Timeout fallback: Claude's own composer bytes, and not a shell prompt. */
export function claudeResumeScreenAcceptsHandoff(screen: string): boolean {
  if (screen.length === 0 || claudeResumeScreenIsShellPrompt(screen)) {
    return false
  }
  return createDraftPasteReadyScanner('claude-composer-prompt').observe(screen).ready
}

export type ClaudeResumeHookRow = {
  state: string
  receivedAt: number
  providerSession?: { id: string }
  providerSessionOnly?: boolean
}

/**
 * The pane is already `done` on this session id before the restart.
 * Only a later `done` plus that same provider session is the new process.
 */
export function claudeResumeHooksReady(args: {
  rows: readonly ClaudeResumeHookRow[]
  identities: readonly { paneKey: string; sessionId: string }[]
  paneKey: string
  sessionId: string
  baselineReceivedAt: number
}): boolean {
  const identity = args.identities.some(
    (entry) => entry.paneKey === args.paneKey && entry.sessionId === args.sessionId
  )
  if (!identity) {
    return false
  }
  return args.rows.some(
    (row) =>
      row.providerSessionOnly !== true &&
      row.state === 'done' &&
      row.receivedAt > args.baselineReceivedAt &&
      row.providerSession?.id === args.sessionId
  )
}

export function claudeResumeHookBaseline(rows: readonly { receivedAt: number }[]): number {
  let baseline = 0
  for (const row of rows) {
    if (row.receivedAt > baseline) {
      baseline = row.receivedAt
    }
  }
  return baseline
}
