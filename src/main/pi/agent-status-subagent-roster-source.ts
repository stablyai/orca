// Why: Pi settles its own turn while pi-subagents children keep running, so the
// generated extension holds the pane's completion until every child it saw start is gone.

// The roster lives on pi.events so an in-process /reload keeps children and listeners.
export function getPiSubagentRosterSetupSourceLines(): string[] {
  return [
    '  const piEventBus = (pi as { events?: { on?: (name: string, handler: (event: unknown) => void) => void } }).events',
    '  const lifecycleState = (piEventBus as { __orcaPiSubagents?: { active: Set<string>; exited?: Set<string>; waiting: boolean; onEvent?: (event: unknown, forcedStatus?: string) => void; listener?: (event: unknown) => void; onRunnerExit?: (event: unknown) => void; runnerExitListener?: (event: unknown) => void } } | undefined)?.__orcaPiSubagents ?? { active: new Set<string>(), waiting: false }',
    '  if (piEventBus) (piEventBus as { __orcaPiSubagents?: unknown }).__orcaPiSubagents = lifecycleState',
    '  if (piEventBus?.on && !(lifecycleState as { listener?: unknown }).listener) {',
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
// exited runners before deciding whether children still hold the pane.
export function getPiSubagentRosterEventSourceLines(): string[] {
  return [
    // Why: a run that reports its own completion does so ~150ms after its runner exits;
    // the grace lets that path (and the wake turn it triggers) settle the pane first.
    '  const RUNNER_EXIT_GRACE_MS = 2000',
    '  let runnerExitCheck: ReturnType<typeof setTimeout> | null = null',
    '  lifecycleState.onEvent = (event: unknown, forcedStatus?: string): void => {',
    "    if (!event || typeof event !== 'object') return",
    '    const record = event as { id?: unknown; runId?: unknown }',
    "    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.runId === 'string' ? record.runId : ''",
    '    const status = forcedStatus ?? (event as { status?: unknown }).status',
    '    if (!id) return',
    "    if (status === 'started') { lifecycleState.active.add(id); post('agent_start'); return }",
    "    if (status !== 'completed' && status !== 'failed' && status !== 'aborted') return",
    '    lifecycleState.active.delete(id)',
    '    lifecycleState.exited?.delete(id)',
    '    if (lifecycleState.waiting) postAgentEndOnce()',
    '  }',
    // Why: awaited workflow children never get subagent:async-complete; their runner
    // exiting is the only end signal pi-subagents publishes for them.
    '  lifecycleState.onRunnerExit = (event: unknown): void => {',
    "    const runId = event && typeof event === 'object' ? (event as { runId?: unknown }).runId : undefined",
    "    if (typeof runId !== 'string' || !lifecycleState.active.has(runId)) return",
    '    if (!lifecycleState.exited) lifecycleState.exited = new Set<string>()',
    '    lifecycleState.exited.add(runId)',
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
