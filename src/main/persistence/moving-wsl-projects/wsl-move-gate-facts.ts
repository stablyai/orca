/**
 * The terminal gate's production facts (mover design, section 3.2), each read from the store that
 * owns it: agent state from the hook server's status store (the single owner, AGENTS.md: Agent
 * Status), foreground work from the same process probe the close-tab warning uses, and running
 * automation runs and live orchestration dispatches from their own stores. This only reads.
 */
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { getAgentResumeArgv } from '../../../shared/agent-resume-argv'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import { isFinalAutomationRunStatus, type AutomationRun } from '../../../shared/automations-types'
import { probePtyRunningWorkWithInspection } from '../../../shared/pty-running-work-probe'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'
import type { WslMoveTerminalScope } from './wsl-move-driver-ports'
import { WSL_MOVE_LIVE_WORKER_STATES } from './wsl-move-orchestration-history-rewrite'
import type { WslMoveRestoreHintPane } from './wsl-move-restore-hints'
import type { WslMoveGateInputs, WslMovePaneFacts } from './wsl-move-terminal-gate'

export type WslMoveLiveTerminal = {
  ptyId: string
  workspaceId: string
  paneKey: string | null
  wslDistro: string | null
  foregroundAgent: string | null
}

export type WslMoveDispatchRow = { dispatchId: string; worktreeId: string | null; state: string }

export type WslMoveGateFactSources = {
  listTerminals: (workspaceIds: readonly string[]) => readonly WslMoveLiveTerminal[]
  inspect: (ptyId: string) => Promise<TerminalProcessInspection>
  /** The hook server's rows for a pane. */
  agentRows: (paneKey: string) => readonly AgentStatusIpcPayload[]
  /** The pane's saved scrollback in bytes; 0 when none. */
  scrollbackBytes: (tabId: string, leafId: string) => Promise<number>
  automationRuns: () => readonly AutomationRun[]
  dispatches: () => readonly WslMoveDispatchRow[]
}

// The close-tab warning's budget; a probe that does not answer reads as unverifiable and blocks.
const PROBE_TIMEOUT_MS = 3_000

const LIVE_WORKER_STATES: ReadonlySet<string> = new Set(WSL_MOVE_LIVE_WORKER_STATES)

export async function collectWslMoveGateInputs(
  sources: WslMoveGateFactSources,
  scope: WslMoveTerminalScope
): Promise<WslMoveGateInputs> {
  const terminals = sources.listTerminals(scope.workspaceIds)
  const probes = await probePtyRunningWorkWithInspection(
    terminals.map((terminal) => terminal.ptyId),
    { timeoutMs: PROBE_TIMEOUT_MS },
    sources.inspect
  )
  const verdicts = new Map(probes.map((probe) => [probe.ptyId, probe.verdict]))
  const panes: WslMovePaneFacts[] = []
  for (const terminal of terminals) {
    const verdict = verdicts.get(terminal.ptyId) ?? 'unverifiable'
    const foreground =
      verdict === 'exited' ? 'shell-idle' : verdict === 'live' ? 'process-running' : 'unverifiable'
    const pane = terminal.paneKey ? parsePaneKey(terminal.paneKey) : null
    if (!terminal.paneKey || !pane) {
      // A terminal with no pane cannot be restored on the host, so it can never pass as idle.
      panes.push({
        paneKey: `pty:${terminal.ptyId}`,
        foreground: 'unverifiable',
        scrollbackBytes: 0
      })
      continue
    }
    const agent = agentFacts(sources.agentRows(terminal.paneKey), terminal.foregroundAgent)
    panes.push({
      paneKey: terminal.paneKey,
      foreground,
      ...(agent ? { agent } : {}),
      scrollbackBytes: await sources.scrollbackBytes(pane.tabId, pane.leafId).catch(() => -1)
    })
  }
  const inScope = workspaceMatcher(scope)
  return {
    panes,
    runningAutomationRunIds: sources
      .automationRuns()
      .filter((run) => !isFinalAutomationRunStatus(run.status) && inScope(run.workspaceId))
      .map((run) => run.id),
    activeDispatchIds: sources
      .dispatches()
      .filter((row) => LIVE_WORKER_STATES.has(row.state) && inScope(row.worktreeId))
      .map((row) => row.dispatchId)
  }
}

/** The panes the pause carries, read while their sessions still run. */
export function listWslMovePanes(
  sources: Pick<WslMoveGateFactSources, 'listTerminals'>,
  scope: WslMoveTerminalScope
): WslMoveRestoreHintPane[] {
  return sources
    .listTerminals(scope.workspaceIds)
    .flatMap((terminal) =>
      terminal.paneKey
        ? [{ paneKey: terminal.paneKey, sessionId: terminal.ptyId, wslDistro: terminal.wslDistro }]
        : []
    )
}

function agentFacts(
  rows: readonly AgentStatusIpcPayload[],
  foregroundAgent: string | null
): WslMovePaneFacts['agent'] | undefined {
  const current = rows
    .filter((row) => !row.providerSessionOnly)
    .reduce<AgentStatusIpcPayload | undefined>(
      (latest, row) => (!latest || row.receivedAt > latest.receivedAt ? row : latest),
      undefined
    )
  if (!current) {
    return undefined
  }
  const { agentType, providerSession } = current
  const resumable =
    isResumableTuiAgent(agentType) &&
    providerSession !== undefined &&
    getAgentResumeArgv(agentType, providerSession) !== null
  return {
    state: current.state,
    resumable,
    ownsForeground: agentType !== undefined && foregroundAgent === agentType
  }
}

function workspaceMatcher(scope: WslMoveTerminalScope): (id: string | null) => boolean {
  const ids = new Set([...scope.workspaceIds, ...scope.workspaceKeys])
  return (id) => id !== null && ids.has(id)
}
