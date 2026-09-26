// Why: Pi settles its own turn while pi-subagents children keep running, so the
// generated extension holds the pane's completion until every child it saw start is gone.

// Module scope: post() reads the roster when a body is built, so a coalesced or
// retried post always carries the children live at delivery.
export function getPiSubagentSnapshotSourceLines(): string[] {
  return [
    'type SubagentDetail = { agentType?: string; description?: string; startedAt: number; workflow?: boolean }',
    'type SubagentRoster = { active: Set<string>; exited?: Set<string>; details?: Map<string, SubagentDetail>; waiting: boolean; onEvent?: (event: unknown, forcedStatus?: string) => void; listener?: (event: unknown) => void; onRunnerExit?: (event: unknown) => void; runnerExitListener?: (event: unknown) => void }',
    '// Mirrors AGENT_STATUS_MAX_SUBAGENTS; the host enforces the same cap.',
    'const MAX_SUBAGENT_SNAPSHOT = 32',
    'let subagentRoster: SubagentRoster | null = null',
    '',
    // Why: an exited runner is already gone, and a pi-subagents workflow run is the lead
    // coordinating children that post their own rows; both still hold the pane.
    'function isVisibleSubagent(roster: SubagentRoster, id: string): boolean {',
    '  return roster.active.has(id) && !roster.exited?.has(id) && roster.details?.get(id)?.workflow !== true',
    '}',
    '',
    'function subagentPayload(): Record<string, unknown> {',
    '  if (!subagentRoster) return {}',
    '  const subagents: Record<string, unknown>[] = []',
    '  for (const id of subagentRoster.active) {',
    '    if (!isVisibleSubagent(subagentRoster, id)) continue',
    '    const detail = subagentRoster.details?.get(id)',
    "    subagents.push({ id, state: 'working', startedAt: detail?.startedAt ?? 0, ...(detail?.agentType ? { agentType: detail.agentType } : {}), ...(detail?.description ? { description: detail.description } : {}) })",
    '    if (subagents.length >= MAX_SUBAGENT_SNAPSHOT) break',
    '  }',
    '  return subagents.length > 0 ? { subagents } : {}',
    '}',
    ''
  ]
}

// The roster lives on pi.events so an in-process /reload keeps children and listeners.
export function getPiSubagentRosterSetupSourceLines(): string[] {
  return [
    '  const piEventBus = (pi as { events?: { on?: (name: string, handler: (event: unknown) => void) => void } }).events',
    '  const lifecycleState: SubagentRoster = (piEventBus as { __orcaPiSubagents?: SubagentRoster } | undefined)?.__orcaPiSubagents ?? { active: new Set<string>(), waiting: false }',
    '  if (piEventBus) (piEventBus as { __orcaPiSubagents?: unknown }).__orcaPiSubagents = lifecycleState',
    // Why: optional on the shared roster so one created by an older in-process build gains it on /reload.
    '  const subagentDetails = (lifecycleState.details ??= new Map<string, SubagentDetail>())',
    '  subagentRoster = lifecycleState',
    '  function resetSubagentRoster(): void {',
    '    lifecycleState.active.clear()',
    '    lifecycleState.exited?.clear()',
    '    subagentDetails.clear()',
    '    lifecycleState.waiting = false',
    '  }',
    '  if (piEventBus?.on && !lifecycleState.listener) {',
    '    const listener = (event: unknown) => lifecycleState.onEvent?.(event)',
    '    lifecycleState.listener = listener',
    "    piEventBus.on('task:subagent:lifecycle', listener)",
    "    piEventBus.on('subagent:async-started', (event: unknown) => lifecycleState.onEvent?.(event, 'started'))",
    "    piEventBus.on('subagent:async-complete', (event: unknown) => lifecycleState.onEvent?.(event, 'completed'))",
    '  }',
    // Why: separate guard so a roster created by an older in-process build still subscribes.
    '  if (piEventBus?.on && !lifecycleState.runnerExitListener) {',
    '    const runnerExitListener = (event: unknown) => lifecycleState.onRunnerExit?.(event)',
    '    lifecycleState.runnerExitListener = runnerExitListener',
    "    piEventBus.on('subagent:process-terminal', runnerExitListener)",
    '  }'
  ]
}

// Expects post() and postAgentEndOnce() from the handler scope; the latter prunes
// exited runners, then returns whether it settled the pane.
export function getPiSubagentRosterEventSourceLines(): string[] {
  return [
    // Why: a run that reports its own completion does so ~150ms after its runner exits;
    // the grace lets that path (and the wake turn it triggers) settle the pane first.
    '  const RUNNER_EXIT_GRACE_MS = 2000',
    '  let runnerExitCheck: ReturnType<typeof setTimeout> | null = null',
    // Why: a child can end with no lead event to carry it; a queued post already reads the new roster.
    '  function postSubagentsUpdate(): void {',
    "    if (!hasQueuedPost()) post('subagents_update')",
    '  }',
    "  const readLabel = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined",
    '  lifecycleState.onEvent = (event: unknown, forcedStatus?: string): void => {',
    "    if (!event || typeof event !== 'object') return",
    '    const record = event as { id?: unknown; runId?: unknown; agent?: unknown; description?: unknown; mode?: unknown }',
    "    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.runId === 'string' ? record.runId : ''",
    '    const status = forcedStatus ?? (event as { status?: unknown }).status',
    '    if (!id) return',
    "    if (status === 'started') {",
    '      lifecycleState.active.add(id)',
    // Why: pi-subagents redacts task prompts, so only the agent name and OMP's short label are shown.
    "      if (!subagentDetails.has(id)) subagentDetails.set(id, { agentType: readLabel(record.agent), description: readLabel(record.description), startedAt: Date.now(), workflow: record.mode === 'workflow' })",
    "      post('agent_start')",
    '      return',
    '    }',
    "    if (status !== 'completed' && status !== 'failed' && status !== 'aborted') return",
    '    const wasVisible = isVisibleSubagent(lifecycleState, id)',
    '    lifecycleState.active.delete(id)',
    '    lifecycleState.exited?.delete(id)',
    '    subagentDetails.delete(id)',
    '    if (lifecycleState.waiting && postAgentEndOnce()) return',
    '    if (wasVisible) postSubagentsUpdate()',
    '  }',
    // Why: awaited workflow children never get subagent:async-complete; their runner
    // exiting is the only end signal pi-subagents publishes for them.
    '  lifecycleState.onRunnerExit = (event: unknown): void => {',
    "    const runId = event && typeof event === 'object' ? (event as { runId?: unknown }).runId : undefined",
    "    if (typeof runId !== 'string' || !lifecycleState.active.has(runId)) return",
    '    if (!lifecycleState.exited) lifecycleState.exited = new Set<string>()',
    '    const wasVisible = isVisibleSubagent(lifecycleState, runId)',
    '    lifecycleState.exited.add(runId)',
    '    if (wasVisible) postSubagentsUpdate()',
    '    if (!lifecycleState.waiting) return',
    '    if (runnerExitCheck !== null) clearTimeout(runnerExitCheck)',
    '    runnerExitCheck = setTimeout(() => {',
    '      runnerExitCheck = null',
    '      if (lifecycleState.waiting) postAgentEndOnce()',
    '    }, RUNNER_EXIT_GRACE_MS)',
    "    if (typeof runnerExitCheck.unref === 'function') runnerExitCheck.unref()",
    '  }'
  ]
}
