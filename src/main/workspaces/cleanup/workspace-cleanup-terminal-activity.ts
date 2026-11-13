import type { IPtyProvider } from '../../providers/pty-provider-contract'
import { inspectPtyProviderProcess } from '../../providers/pty-process-inspection'
import { worktreePtyOwnership } from '../../providers/worktree-pty-ownership'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-terminal-contracts'
import type { TerminalProcessInspection } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import {
  classifyTerminalProcessInspectionFailure,
  isClientOnlyUnverifiableInspection
} from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { AgentStatusState } from '../../../shared/agent-status/contracts/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

export type WorkspaceCleanupTerminalActivity = 'idle' | 'running' | 'unknown'

/** Each pane's agent state from the host's agent rows; a pane with no row has no idle proof. */
export type WorkspaceCleanupPaneAgentStates = ReadonlyMap<string, AgentStatusState>

export type WorkspaceCleanupTerminalRuntime = {
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { requireFreshPtyLiveness?: boolean }
  ): Promise<RuntimeTerminalListResult>
  getLocalProvider(): IPtyProvider | null
}

const TERMINAL_LIST_LIMIT = 10_000
const PROVIDER_LIST_DEADLINE_MS = 5_000

/** Like the cleanup dialog: an idle shell, or an agent CLI sitting at its prompt, is not running. */
function classifyInspection(
  inspection: TerminalProcessInspection,
  paneAgentState: AgentStatusState | undefined
): WorkspaceCleanupTerminalActivity {
  if (
    isClientOnlyUnverifiableInspection(inspection) ||
    inspection.childProcessEvidence === 'unverifiable'
  ) {
    return 'unknown'
  }
  const processName = inspection.foregroundProcess
  if (!inspection.hasChildProcesses && (!processName || isShellProcess(processName))) {
    return 'idle'
  }
  // Agent CLIs keep helper children (MCP servers); only its own pane's finished turn proves one is idle.
  return recognizeAgentProcess(processName) && paneAgentState === 'done' ? 'idle' : 'running'
}

async function listWorktreePtyIds(
  runtime: WorkspaceCleanupTerminalRuntime,
  provider: IPtyProvider,
  worktreeId: string
): Promise<Map<string, string | null>> {
  const [listed, sessions] = await Promise.all([
    runtime.listTerminals(`id:${worktreeId}`, TERMINAL_LIST_LIMIT, {
      requireFreshPtyLiveness: true
    }),
    provider.listProcesses({ deadlineMs: Date.now() + PROVIDER_LIST_DEADLINE_MS, worktreeId })
  ])
  if (listed.truncated) {
    throw new Error('terminal_list_truncated')
  }
  // Pty id -> pane key; provider sessions the graph never bound have no pane.
  const ptyIds = new Map<string, string | null>()
  for (const terminal of listed.terminals) {
    if (terminal.verdict === 'unverifiable') {
      throw new Error('terminal_unverifiable')
    }
    if (terminal.ptyId && terminal.connected) {
      ptyIds.set(
        terminal.ptyId,
        isTerminalLeafId(terminal.leafId) ? makePaneKey(terminal.tabId, terminal.leafId) : null
      )
    }
  }
  // Removal's teardown also stops provider sessions the graph never bound; inspect what it would stop.
  for (const session of sessions.filter(worktreePtyOwnership(worktreeId))) {
    if (!ptyIds.has(session.id)) {
      ptyIds.set(session.id, null)
    }
  }
  return ptyIds
}

/** Whether any terminal removal would stop is doing work; any doubt reads as 'unknown'. */
export async function readWorkspaceCleanupTerminalActivity(
  runtime: WorkspaceCleanupTerminalRuntime,
  worktreeId: string,
  paneAgentStates: WorkspaceCleanupPaneAgentStates
): Promise<WorkspaceCleanupTerminalActivity> {
  const provider = runtime.getLocalProvider()
  if (!provider) {
    return 'unknown'
  }
  let ptyIds: Map<string, string | null>
  try {
    ptyIds = await listWorktreePtyIds(runtime, provider, worktreeId)
  } catch {
    return 'unknown'
  }
  let unknown = false
  for (const [ptyId, paneKey] of ptyIds) {
    let inspection: TerminalProcessInspection
    try {
      // Teardown stops sessions no window has reattached since a relaunch, so inspect those too.
      inspection = await inspectPtyProviderProcess(provider, ptyId, {
        scanChildProcesses: true,
        includeUnattached: true
      })
    } catch (error) {
      if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
        continue
      }
      unknown = true
      continue
    }
    const activity = classifyInspection(
      inspection,
      paneKey ? paneAgentStates.get(paneKey) : undefined
    )
    if (activity === 'running') {
      return 'running'
    }
    unknown ||= activity === 'unknown'
  }
  return unknown ? 'unknown' : 'idle'
}
