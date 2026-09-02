/** The terminal/worktree capabilities the coordinator needs from the runtime it drives. */
export type WorktreeDrift = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

export type CoordinatorRuntime = {
  sendTerminalAgentPrompt(handle: string, prompt: string): Promise<unknown>
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
  // Why (§3.1): lives on the runtime because it must resolve a worktree, load the repo, and fetch — the coordinator only knows handles + specs.
  probeWorktreeDrift(worktreeSelector: string): Promise<WorktreeDrift>
  // Why: pane-only fallback preserves reservation identity for lightweight runtime fakes.
  getTerminalPaneKey?(handle: string): string | null
  // Why optional: lightweight fakes omit it and get the fail-closed default.
  getNestedWorkerMaxDepth?(): number
  // Why: automatic dispatch persists the same authenticated pane/process tuple as manual dispatch.
  getOrchestrationDispatchAuthority?(handle: string): {
    paneKey: string | null
    processIncarnation: string | null
    launchTokenHash: string | null
  } | null
  // Why: Windows can host native and WSL workers at once, so the worker pane (not the coordinator) picks the packaged CLI name.
  getTerminalOrchestrationCliCommand?(handle: string): 'orca' | 'orca-ide'
}
