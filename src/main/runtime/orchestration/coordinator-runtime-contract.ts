import type { WorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
import type { DispatchPreambleSendOptions } from './preamble'

export type WorktreeDrift = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

export type CoordinatorRuntime = {
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: DispatchPreambleSendOptions
  ): Promise<unknown>
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { includeVisualLayouts?: boolean }
  ): Promise<{
    terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  }>
  createTerminal(
    worktreeSelector?: string,
    opts?: { command?: string; title?: string }
  ): Promise<{ handle: string; worktreeId: string }>
  waitForTerminal(
    handle: string,
    options?: { condition?: string; timeoutMs?: number }
  ): Promise<{ handle: string; condition: string }>
  // The runtime resolves repositories and fetches; the coordinator only knows handles and specs.
  probeWorktreeDrift(worktreeSelector: string): Promise<WorktreeDrift>
  // Pane-only fallback retains reservation identity in lightweight fakes.
  getTerminalPaneKey?(handle: string): string | null
  // Omitted by lightweight fakes; absence uses the fail-closed default.
  getNestedWorkerMaxDepth?(): number
  // Automatic dispatch must persist the same authenticated pane/process authority as manual dispatch.
  getOrchestrationDispatchAuthority?(handle: string): {
    paneKey: string | null
    processIncarnation: string | null
    launchTokenHash: string | null
    hostScope?: WorkerTerminalHostScope
  } | null
  // The worker's native/WSL pane determines its packaged CLI name.
  getTerminalOrchestrationCliCommand?(handle: string): 'orca' | 'orca-dev' | 'orca-ide'
}
