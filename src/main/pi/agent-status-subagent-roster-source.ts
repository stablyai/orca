// Why: Pi settles its own turn while pi-subagents children keep running, so the
// generated extension holds the pane's completion until every child it saw start is gone.

import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { AGENT_STATUS_MAX_SUBAGENTS } from '../../shared/agent-status-types'

// Module scope: post() reads the roster when a body is built, so a coalesced or
// retried post always carries the children live at delivery.
export function getPiSubagentSnapshotSourceLines(): string[] {
  return [
    'type SubagentDetail = { agentType?: string; description?: string; startedAt: number; workflow?: boolean; parent?: string; registration?: object }',
    'type SubagentRoster = { active: Set<string>; exited?: Set<string>; details?: Map<string, SubagentDetail>; waiting: boolean; ownsPane?: boolean; runGeneration?: number; endedRunGeneration?: number; completionPostedGeneration?: number; parked?: Map<string, Map<string, SubagentDetail>>; onEvent?: (event: unknown, forcedStatus?: string) => void; listener?: (event: unknown) => void; onRunnerExit?: (event: unknown) => void; runnerExitListener?: (event: unknown) => void; runnerExitCheck?: ReturnType<typeof setTimeout> | null; onRunnerExitSettled?: () => void }',
    // Why: interpolated, not re-typed, so the extension cap cannot drift from the host's.
    `const MAX_SUBAGENT_SNAPSHOT = ${AGENT_STATUS_MAX_SUBAGENTS}`,
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

// The run state (children, the hold, the turn counters) has to outlive a registration: Pi hands
// each one a fresh `pi.events` and evaluates this module again on /reload, so only globalThis
// survives there. OMP and Prime keep one bus for the session.
export function getPiSubagentRosterSetupSourceLines(kind: PiAgentKind): string[] {
  return [
    '  const piEventBus = (pi as { events?: { __orcaPiSubagents?: SubagentRoster; __orcaPiSubagentsHeard?: boolean; __orcaPiRunnerExitsHeard?: boolean; on?: (name: string, handler: (event: unknown) => void) => void } }).events',
    kind === 'pi'
      ? '  const runStateHome: { __orcaPiSubagents?: SubagentRoster } | undefined = isOmpRuntime() ? piEventBus : (globalThis as { __orcaPiSubagents?: SubagentRoster })'
      : '  const runStateHome: { __orcaPiSubagents?: SubagentRoster } | undefined = piEventBus',
    // Why: a roster an older in-process build left on this bus is adopted, with the subscriptions it made.
    '  const busRoster = piEventBus?.__orcaPiSubagents',
    '  const lifecycleState: SubagentRoster = busRoster ?? runStateHome?.__orcaPiSubagents ?? { active: new Set<string>(), waiting: false }',
    '  if (runStateHome) runStateHome.__orcaPiSubagents = lifecycleState',
    // Why: optional on the shared roster so one created by an older in-process build gains them on /reload.
    '  const subagentDetails = (lifecycleState.details ??= new Map<string, SubagentDetail>())',
    // Why: completion is a per-RUN fact. A sibling extension (the memory reminder is one) can
    // start the next run from inside its own agent_settled handler, so this extension sees that
    // run's agent_start BEFORE its own agent_settled for the run that just ended; a boolean
    // "already posted" latch would eat the newer run's completion.
    '  lifecycleState.runGeneration ??= 0',
    '  lifecycleState.endedRunGeneration ??= 0',
    '  lifecycleState.completionPostedGeneration ??= -1',
    // Why: an OMP task child runs this factory again on its own bus. Posts keep describing the
    // lead's children, and the child's own subagents must not settle the lead's pane.
    '  subagentRoster ??= lifecycleState',
    '  const ownsPaneRoster = subagentRoster === lifecycleState',
    // Tells the children this registration saw start from the ones a /reload handed it.
    '  const registration = {}',
    '  function resetSubagentRoster(): void {',
    '    clearRunnerExitCheck()',
    '    lifecycleState.active.clear()',
    '    lifecycleState.exited?.clear()',
    '    subagentDetails.clear()',
    '    lifecycleState.waiting = false',
    '  }',
    // Why: one subscription per bus object; Pi drops a replaced registration's own.
    '  if (ownsPaneRoster && piEventBus?.on && !piEventBus.__orcaPiSubagentsHeard && !busRoster?.listener) {',
    '    piEventBus.__orcaPiSubagentsHeard = true',
    "    piEventBus.on('task:subagent:lifecycle', (event: unknown) => lifecycleState.onEvent?.(event))",
    "    piEventBus.on('subagent:async-started', (event: unknown) => lifecycleState.onEvent?.(event, 'started'))",
    "    piEventBus.on('subagent:async-complete', (event: unknown) => lifecycleState.onEvent?.(event, 'completed'))",
    '  }',
    '  if (ownsPaneRoster && piEventBus?.on && !piEventBus.__orcaPiRunnerExitsHeard && !busRoster?.runnerExitListener) {',
    '    piEventBus.__orcaPiRunnerExitsHeard = true',
    "    piEventBus.on('subagent:process-terminal', (event: unknown) => lifecycleState.onRunnerExit?.(event))",
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
    '  function clearRunnerExitCheck(): void {',
    '    if (lifecycleState.runnerExitCheck != null) clearTimeout(lifecycleState.runnerExitCheck)',
    '    lifecycleState.runnerExitCheck = null',
    '  }',
    '  function forgetSubagent(id: string): void {',
    '    lifecycleState.active.delete(id)',
    '    lifecycleState.exited?.delete(id)',
    '    subagentDetails.delete(id)',
    '  }',
    // Why: a child can end with no lead event to carry it; a queued post already reads the new roster.
    '  function postSubagentsUpdate(): void {',
    "    if (!hasQueuedPost()) post('subagents_update')",
    '  }',
    "  const readLabel = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined",
    '  lifecycleState.onEvent = (event: unknown, forcedStatus?: string): void => {',
    "    if (!event || typeof event !== 'object') return",
    '    const record = event as { id?: unknown; runId?: unknown; agent?: unknown; description?: unknown; mode?: unknown; parentWorkflowRunId?: unknown }',
    "    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.runId === 'string' ? record.runId : ''",
    '    const status = forcedStatus ?? (event as { status?: unknown }).status',
    '    if (!id) return',
    '    if (isOmpRuntime() && !lifecycleState.ownsPane) return',
    "    if (status === 'started') {",
    '      lifecycleState.active.add(id)',
    // Why: pi-subagents redacts task prompts, so only the agent name and OMP's short label are shown.
    "      if (!subagentDetails.has(id)) subagentDetails.set(id, { agentType: readLabel(record.agent), description: readLabel(record.description), startedAt: Date.now(), workflow: record.mode === 'workflow', parent: readLabel(record.parentWorkflowRunId), registration })",
    // Why: Pi re-opens only a posted completion; an earlier child must leave the idle check intact.
    '      if (!isTurnInFlight() && (isOmpRuntime() || lifecycleState.runGeneration === 0 || lifecycleState.completionPostedGeneration === lifecycleState.runGeneration)) {',
    '        lifecycleState.waiting = true',
    '        lifecycleState.completionPostedGeneration = -1',
    '      }',
    "      post('agent_start')",
    '      return',
    '    }',
    "    if (status !== 'completed' && status !== 'failed' && status !== 'aborted') return",
    '    let wasVisible = isVisibleSubagent(lifecycleState, id)',
    '    forgetSubagent(id)',
    // Why: Pi drops the runner-exit events of runs started before a /reload, so a finished run
    // takes the children it launched back then with it.
    '    for (const [childId, detail] of subagentDetails) {',
    '      if (detail.parent !== id || detail.registration === registration) continue',
    '      wasVisible ||= isVisibleSubagent(lifecycleState, childId)',
    '      forgetSubagent(childId)',
    '    }',
    '    if (lifecycleState.waiting && postAgentEndOnce()) return',
    '    if (wasVisible) postSubagentsUpdate()',
    '  }',
    // Why: awaited workflow children never get subagent:async-complete; their runner
    // exiting is the only end signal pi-subagents publishes for them.
    '  lifecycleState.onRunnerExitSettled = (): void => {',
    '    if (lifecycleState.waiting) postAgentEndOnce()',
    '  }',
    '  lifecycleState.onRunnerExit = (event: unknown): void => {',
    "    const runId = event && typeof event === 'object' ? (event as { runId?: unknown }).runId : undefined",
    "    if (typeof runId !== 'string' || !lifecycleState.active.has(runId)) return",
    '    if (!lifecycleState.exited) lifecycleState.exited = new Set<string>()',
    '    const wasVisible = isVisibleSubagent(lifecycleState, runId)',
    '    lifecycleState.exited.add(runId)',
    '    if (wasVisible) postSubagentsUpdate()',
    '    if (!lifecycleState.waiting) return',
    '    clearRunnerExitCheck()',
    '    lifecycleState.runnerExitCheck = setTimeout(() => {',
    '      lifecycleState.runnerExitCheck = null',
    '      lifecycleState.onRunnerExitSettled?.()',
    '    }, RUNNER_EXIT_GRACE_MS)',
    "    if (typeof lifecycleState.runnerExitCheck.unref === 'function') lifecycleState.runnerExitCheck.unref()",
    '  }'
  ]
}
