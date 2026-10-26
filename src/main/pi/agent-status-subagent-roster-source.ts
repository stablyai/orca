// Hold Pi completion until its observed subagents finish.

import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { HOOK_REQUEST_MAX_BYTES } from '../../shared/agent-hook-listener/request-body'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from '../../shared/agent-status-field-normalization'

// Build retried/coalesced posts from the roster live at delivery.
export function getPiSubagentSnapshotSourceLines(): string[] {
  return [
    'type SubagentDetail = { agentType?: string; description?: string; startedAt: number; workflow?: boolean; parent?: string; registration?: object }',
    'type SubagentRoster = { active: Set<string>; exited?: Set<string>; details?: Map<string, SubagentDetail>; waiting: boolean; ownsPane?: boolean; runGeneration?: number; endedRunGeneration?: number; completionPostedGeneration?: number; parked?: Map<string, Map<string, SubagentDetail>>; onEvent?: (event: unknown, forcedStatus?: string) => void; listener?: (event: unknown) => void; onRunnerExit?: (event: unknown) => void; runnerExitListener?: (event: unknown) => void; runnerExitCheck?: ReturnType<typeof setTimeout> | null; onRunnerExitSettled?: () => void }',
    // Half the host body limit also bounds roster JSON structure tokens.
    `const HOOK_BODY_BUDGET_BYTES = ${Math.floor(HOOK_REQUEST_MAX_BYTES / 2)}`,
    'const SUBAGENTS_FIELD_BYTES = Buffer.byteLength(\',"subagents":[]\')',
    'let subagentRoster: SubagentRoster | null = null',
    '',
    // Exited runners and workflow leads hold the pane without contributing visible child rows.
    'function isVisibleSubagent(roster: SubagentRoster, id: string): boolean {',
    '  return roster.active.has(id) && !roster.exited?.has(id) && roster.details?.get(id)?.workflow !== true',
    '}',
    '',
    'function subagentPreview(value: string | undefined, maxLength: number): string | undefined {',
    "  if (typeof value !== 'string') return undefined",
    "  let preview = value.slice(0, maxLength * 8 + 64).trimStart().replace(/[\\r\\n\\u2028\\u2029]+/g, ' ').slice(0, maxLength)",
    '  if (preview.length < maxLength) preview = preview.trimEnd()',
    '  else if (/[\\ud800-\\udbff]$/.test(preview)) preview = preview.slice(0, -1)',
    '  return preview || undefined',
    '}',
    '',
    // Payload truncation must not discard active children from ownership tracking.
    'function subagentPayload(byteBudget: number): Record<string, unknown> {',
    '  if (!subagentRoster) return {}',
    '  const subagents: Record<string, unknown>[] = []',
    '  let bytes = SUBAGENTS_FIELD_BYTES',
    '  for (const id of subagentRoster.active) {',
    '    if (!isVisibleSubagent(subagentRoster, id)) continue',
    '    const detail = subagentRoster.details?.get(id)',
    `    const agentType = subagentPreview(detail?.agentType, ${AGENT_TYPE_MAX_LENGTH})`,
    `    const description = subagentPreview(detail?.description, ${AGENT_STATUS_TOOL_INPUT_MAX_LENGTH})`,
    "    const subagent = { id, state: 'working', startedAt: detail?.startedAt ?? 0, ...(agentType ? { agentType } : {}), ...(description ? { description } : {}) }",
    '    const rowBytes = Buffer.byteLength(JSON.stringify(subagent)) + (subagents.length > 0 ? 1 : 0)',
    '    if (bytes + rowBytes > byteBudget) continue',
    '    bytes += rowBytes',
    '    subagents.push(subagent)',
    '  }',
    '  return subagents.length > 0 ? { subagents } : {}',
    '}',
    ''
  ]
}

// Pi replaces registrations/buses and reloads modules; globalThis retains run state. OMP/Prime retain their bus.
export function getPiSubagentRosterSetupSourceLines(kind: PiAgentKind): string[] {
  return [
    '  const piEventBus = (pi as { events?: { __orcaPiSubagents?: SubagentRoster; __orcaPiSubagentsHeard?: boolean; __orcaPiRunnerExitsHeard?: boolean; on?: (name: string, handler: (event: unknown) => void) => void } }).events',
    kind === 'pi'
      ? '  const runStateHome: { __orcaPiSubagents?: SubagentRoster } | undefined = isOmpRuntime() ? piEventBus : (globalThis as { __orcaPiSubagents?: SubagentRoster })'
      : '  const runStateHome: { __orcaPiSubagents?: SubagentRoster } | undefined = piEventBus',
    // Adopt older in-process rosters with their existing subscriptions.
    '  const busRoster = piEventBus?.__orcaPiSubagents',
    '  const lifecycleState: SubagentRoster = busRoster ?? runStateHome?.__orcaPiSubagents ?? { active: new Set<string>(), waiting: false }',
    '  if (runStateHome) runStateHome.__orcaPiSubagents = lifecycleState',
    // Reload upgrades rosters created by older in-process builds.
    '  const subagentDetails = (lifecycleState.details ??= new Map<string, SubagentDetail>())',
    // A sibling may start the next run before this run settles; completion needs a per-run counter.
    '  lifecycleState.runGeneration ??= 0',
    '  lifecycleState.endedRunGeneration ??= 0',
    '  lifecycleState.completionPostedGeneration ??= -1',
    // OMP task children get separate buses; their subagents must not settle the lead pane.
    '  subagentRoster ??= lifecycleState',
    '  const ownsPaneRoster = subagentRoster === lifecycleState',
    // Distinguish children observed here from those inherited through reload.
    '  const registration = {}',
    '  function resetSubagentRoster(): void {',
    '    clearRunnerExitCheck()',
    '    lifecycleState.active.clear()',
    '    lifecycleState.exited?.clear()',
    '    subagentDetails.clear()',
    '    lifecycleState.waiting = false',
    '  }',
    // Replaced Pi registrations lose their subscriptions; subscribe once per bus.
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

export function getPiSubagentRosterEventSourceLines(): string[] {
  return [
    // Runner exit can precede self-reported completion by ~150ms; allow that path and its wake turn first.
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
    // Child exit may have no lead event; queued posts already read the live roster.
    '  function postSubagentsUpdate(): void {',
    "    if (!hasQueuedPost()) post('subagents_update')",
    '  }',
    "  const readLabel = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined",
    '  lifecycleState.onEvent = (event: unknown, forcedStatus?: string): void => {',
    "    if (!event || typeof event !== 'object') return",
    '    const record = event as { id?: unknown; runId?: unknown; agent?: unknown; description?: unknown; workflowKey?: unknown; mode?: unknown; parentWorkflowRunId?: unknown }',
    "    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.runId === 'string' ? record.runId : ''",
    '    const status = forcedStatus ?? (event as { status?: unknown }).status',
    '    if (!id) return',
    '    if (isOmpRuntime() && !lifecycleState.ownsPane) return',
    "    if (status === 'started') {",
    '      lifecycleState.active.add(id)',
    // Use labels/step keys because pi-subagents redacts task prompts; keys distinguish same-agent siblings.
    "      if (!subagentDetails.has(id)) subagentDetails.set(id, { agentType: readLabel(record.agent), description: readLabel(record.description) ?? readLabel(record.workflowKey), startedAt: Date.now(), workflow: record.mode === 'workflow', parent: readLabel(record.parentWorkflowRunId), registration })",
    // Pi reopens only posted completions; earlier children must preserve the idle check.
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
    // Reload loses old runner-exit delivery; finishing their parent must retire those children.
    '    for (const [childId, detail] of subagentDetails) {',
    '      if (detail.parent !== id || detail.registration === registration) continue',
    '      wasVisible ||= isVisibleSubagent(lifecycleState, childId)',
    '      forgetSubagent(childId)',
    '    }',
    '    if (lifecycleState.waiting && postAgentEndOnce()) return',
    '    if (wasVisible) postSubagentsUpdate()',
    '  }',
    // Awaited workflow children publish only runner exit, never async-complete.
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
