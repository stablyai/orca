import { getOmpModelCommandSourceLines } from './omp-model-command-source'
import { getPiPrefillHandlerSourceLines } from './prefill-extension-source'
import { getAgentStatusInputRedactionSourceLines } from './agent-status-input-redaction-source'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { getOmpSessionOwnerHandlerSourceLines } from './omp-session-status-owner-source'
import { getPiAgentStatusUiPromptHandlerSourceLines } from './agent-status-ui-prompt-source'
import {
  getPiSubagentRosterEventSourceLines,
  getPiSubagentRosterSetupSourceLines
} from './agent-status-subagent-roster-source'

// Why: keep the generated handler registrations separate from hook transport;
// both are independently sizeable and the installed extension concatenates them.
export function getPiAgentStatusHandlerSourceLines(kind: PiAgentKind): string[] {
  const sessionStartHandler =
    kind !== 'omp'
      ? [
          "  onStatus('session_start', (event, ctx) => {",
          '    updateSessionMetadata(ctx)',
          ...(kind === 'pi' ? ['    piUiPromptDepth = 0'] : []),
          '    // Why: /reload re-registers the active session, but it is not a',
          '    // turn boundary and must not clear the visible status or unread state.',
          "    if (event.reason === 'reload') return",
          ...(kind === 'pi'
            ? [
                // Why: Pi also shuts down for /reload, so a new session is its only roster boundary;
                // pi-subagents never delivers the old session's completions to the new one.
                '    const heldByChildren = lifecycleState.waiting',
                '    resetSubagentRoster()',
                // Why: nothing else will end the run those children held open, so settle it now.
                '    if (heldByChildren) postAgentEndOnce()'
              ]
            : []),
          "    post('session_start')",
          '  })',
          ''
        ]
      : []

  // Why: OMP can switch sessions in-process, so each latest-only post needs fresh identity.
  const ctxParam = ', ctx'
  const bareCtxParams = '_event, ctx'
  const captureSessionMetadata = ['    updateRuntimeOmpSessionMetadata(ctx)']
  const primeDaemonWorkerGuard =
    kind === 'prime-agent'
      ? [
          '  // Why: Prime loads extensions in both its frontend and event-emitting daemon worker.',
          '  if (!process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER) return'
        ]
      : []
  const ownerEnv = kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'

  // Why: OMP suppresses its approval lifecycle unless an extension listens for it,
  // and it is the only signal that the run is parked on a permission prompt rather
  // than still working. Prime has no OMP runtime, so the handlers would be dead there.
  const approvalHandlers =
    kind === 'prime-agent'
      ? []
      : [
          `  onStatus('tool_approval_requested', (event${ctxParam}) => {`,
          ...captureSessionMetadata,
          '    if (!isOmpRuntime()) return',
          "    post('tool_approval_requested', {",
          '      tool_name: event.toolName,',
          '      reason: event.reason,',
          '      approval_mode: event.approvalMode,',
          '    })',
          '  })',
          '',
          `  onStatus('tool_approval_resolved', (event${ctxParam}) => {`,
          ...captureSessionMetadata,
          '    if (!isOmpRuntime()) return',
          "    post('tool_approval_resolved', {",
          '      tool_name: event.toolName,',
          '      approved: event.approved,',
          '    })',
          '  })',
          ''
        ]

  // Why: OMP does not fire model_select today, but Pi does and OMP wraps Pi's
  // runtime; when it arrives it is the one event that reports a switch between turns.
  const modelSelectHandler =
    kind === 'prime-agent'
      ? []
      : [
          `  pi.on('model_select', (event${ctxParam}) => {`,
          ...captureSessionMetadata,
          '    if (!isOmpRuntime()) return',
          '    updateModelMetadata(event)',
          "    post('model_select')",
          '  })',
          ''
        ]

  return [
    ...getAgentStatusInputRedactionSourceLines(),
    '// Why: pi assistant messages carry content as an array of parts',
    "// ({ type: 'text', text } / tool_use / tool_result / reasoning). We only",
    "// surface the concatenated text parts as the visible 'last assistant",
    "// message' for the dashboard preview — tool_use / reasoning would be",
    '// noise (the dashboard already shows the active tool name + input).',
    'function extractAssistantText(message: unknown): string {',
    "  if (!message || typeof message !== 'object') return ''",
    '  const content = (message as { content?: unknown }).content',
    "  if (typeof content === 'string') return content",
    "  if (!Array.isArray(content)) return ''",
    "  let out = ''",
    '  for (const part of content) {',
    "    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {",
    '      const text = (part as { text?: unknown }).text',
    "      if (typeof text === 'string') out += text",
    '    }',
    '  }',
    '  return out',
    '}',
    '',
    '// Preserve ordinary preview data; credential references never leave the agent host.',
    '// Why: a restarted agent inherits the previous owner PID through env, so a',
    '// dead owner must be claimable or the pane goes silent for good. Only ESRCH',
    '// proves the owner is gone -- every other probe result keeps suppression, so',
    '// a live foreign owner still cannot double-report. Mirrors the tri-state in',
    '// main/agent-hooks/managed-hook-owner-identity.ts, which this runtime cannot',
    '// import (the extension loads inside pi/omp with no Orca deps).',
    'function isStatusOwnerAlive(pid: string): boolean {',
    '  const parsed = Number(pid)',
    '  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 0x7fffffff) return false',
    "  if (typeof process.kill !== 'function') return true",
    '  try {',
    '    process.kill(parsed, 0)',
    '    return true',
    '  } catch (err: unknown) {',
    "    return (err as { code?: string } | null)?.code !== 'ESRCH'",
    '  }',
    '}',
    '',
    "// Why: child agents inherit the lead's pane env; only its process may",
    '// register status hooks. PID identity keeps in-process reloads reporting.',
    'export default function (pi): void {',
    ...primeDaemonWorkerGuard,
    `  const ownerPid = process.env.${ownerEnv}`,
    '  const selfPid = String(process.pid)',
    '  if (ownerPid && ownerPid !== selfPid && isStatusOwnerAlive(ownerPid)) return',
    `  process.env.${ownerEnv} = selfPid`,
    '  resetPostQueue()',
    ...getPiSubagentRosterSetupSourceLines(),
    ...(kind !== 'pi'
      ? [
          "  pi.on('session_shutdown', () => { resetSubagentRoster(); resetPostQueue(); clearPendingAgentEndCheck() })"
        ]
      : []),
    ...(kind !== 'prime-agent'
      ? [
          "  pi.on('session_switch', (_event, ctx) => {",
          '    if (!isOmpRuntime()) return',
          '    resetSubagentRoster()',
          '    resetPostQueue()',
          '    clearPendingAgentEndCheck()',
          '    updateRuntimeOmpSessionMetadata(ctx)',
          '  })'
        ]
      : []),
    ...getOmpSessionOwnerHandlerSourceLines(),
    ...getOmpModelCommandSourceLines(),
    ...sessionStartHandler,
    ...(kind === 'omp' ? getPiPrefillHandlerSourceLines('omp', true) : []),
    `  onStatus('before_agent_start', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    post('before_agent_start', { prompt: event.prompt ?? '' })",
    '  })',
    '',
    `  onStatus('agent_start', (${bareCtxParams}) => {`,
    ...captureSessionMetadata,
    '    clearPendingAgentEndCheck()',
    '    lifecycleState.waiting = false',
    '    runGeneration += 1',
    // Why: a turn cannot begin under a dialog holding input focus, so this is the one
    // boundary that can recover a modal whose close never arrived.
    ...(kind === 'pi' ? ['    piUiPromptDepth = 0', '    piTurnInFlight = true'] : []),
    "    post('agent_start')",
    '  })',
    '',
    `  onStatus('tool_execution_start', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    post('tool_execution_start', {",
    '      tool_name: event.toolName,',
    '      tool_input: sanitizeStatusToolInput(event.args),',
    '    })',
    '  })',
    '',
    `  onStatus('tool_call', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    post('tool_call', {",
    '      tool_name: event.toolName,',
    '      tool_input: sanitizeStatusToolInput(event.input),',
    '    })',
    '  })',
    '',
    `  onStatus('tool_execution_end', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    post('tool_execution_end', {",
    '      tool_name: event.toolName,',
    '    })',
    '  })',
    '',
    ...approvalHandlers,
    ...getPiAgentStatusUiPromptHandlerSourceLines(kind),
    ...modelSelectHandler,
    "  // Why: capture the assistant's final text on each completed message",
    '  // so the dashboard preview reflects the most recent reply even before',
    '  // agent_end fires. message_end is the right hook because pi guarantees',
    '  // it fires after the message is finalized (post-streaming).',
    `  onStatus('message_end', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    if (event.message?.role !== 'assistant') return",
    '    const text = extractAssistantText(event.message)',
    '    if (!text) return',
    "    post('message_end', { role: 'assistant', text })",
    '  })',
    '',
    '  // Why: modern Pi stays non-idle across retry/compaction/follow-up work,',
    '  // while legacy Pi becomes idle after its final agent_end handlers.',
    '  // OMP instead marks non-terminal agent_end events with willContinue, so it',
    '  // returns before the recheck timer is ever armed.',
    '  const AGENT_END_IDLE_RECHECK_MS = 25',
    '  const AGENT_END_IDLE_RECHECK_MAX_MS = 250',
    '  let agentSettledSupported = false',
    // Why: completion is a per-RUN fact. A sibling extension (the memory reminder is one)
    // can start the next run from inside its own agent_settled handler, and Pi dispatches
    // handlers in registration order, so this extension sees that run's agent_start
    // BEFORE its own agent_settled for the run that just ended. A boolean "already
    // posted" latch reset on agent_start then eats the newer run's completion and leaves
    // the host stuck on that run's last working event.
    '  let runGeneration = 0',
    '  let endedRunGeneration = 0',
    '  let completionPostedGeneration = -1',
    '  let agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS',
    '  let pendingAgentEndCheck: ReturnType<typeof setTimeout> | null = null',
    '  let pendingAgentEndContext: { isIdle: () => boolean } | null = null',
    '',
    '  function clearPendingAgentEndCheck(): void {',
    '    if (pendingAgentEndCheck !== null) clearTimeout(pendingAgentEndCheck)',
    '    pendingAgentEndCheck = null',
    '    pendingAgentEndContext = null',
    '  }',
    ...getPiSubagentRosterEventSourceLines(),
    '  function postAgentEndOnce(): boolean {',
    '    for (const id of lifecycleState.exited ?? []) {',
    '      lifecycleState.active.delete(id)',
    '      subagentDetails.delete(id)',
    '    }',
    '    lifecycleState.exited?.clear()',
    '    if (lifecycleState.active.size > 0) {',
    '      lifecycleState.waiting = true',
    '      return false',
    '    }',
    '    lifecycleState.waiting = false',
    '    if (completionPostedGeneration === endedRunGeneration) return false',
    '    completionPostedGeneration = endedRunGeneration',
    // Why: distinct from the completion guard, which holds the generation of the posted run
    // and so starts clean on a pane that has not run a turn yet — that pane is idle, not busy.
    ...(kind === 'pi' ? ['    piTurnInFlight = false'] : []),
    "    post('agent_end')",
    '    return true',
    '  }',
    '',
    '  function checkPendingAgentEnd(): void {',
    '    pendingAgentEndCheck = null',
    '    const ctx = pendingAgentEndContext',
    '    if (!ctx || agentSettledSupported || completionPostedGeneration === endedRunGeneration) {',
    '      pendingAgentEndContext = null',
    '      return',
    '    }',
    '    try {',
    '      if (ctx.isIdle()) {',
    '        pendingAgentEndContext = null',
    '        postAgentEndOnce()',
    '        return',
    '      }',
    '    } catch {',
    '      pendingAgentEndContext = null',
    '      return',
    '    }',
    '    pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, agentEndIdleRecheckMs)',
    "    if (typeof pendingAgentEndCheck.unref === 'function') pendingAgentEndCheck.unref()",
    '    agentEndIdleRecheckMs = Math.min(agentEndIdleRecheckMs * 2, AGENT_END_IDLE_RECHECK_MAX_MS)',
    '  }',
    '',
    `  onStatus('agent_settled', (${bareCtxParams}) => {`,
    ...captureSessionMetadata,
    '    agentSettledSupported = true',
    '    clearPendingAgentEndCheck()',
    '    postAgentEndOnce()',
    '  })',
    '',
    "  onStatus('agent_end', (event, ctx) => {",
    ...captureSessionMetadata,
    '    if (event?.willContinue === true) {',
    '      clearPendingAgentEndCheck()',
    '      return',
    '    }',
    '    endedRunGeneration = runGeneration',
    '    if (isOmpRuntime()) {',
    '      postAgentEndOnce()',
    '      return',
    '    }',
    '    if (agentSettledSupported) return',
    "    if (!ctx || typeof ctx.isIdle !== 'function') {",
    '      postAgentEndOnce()',
    '      return',
    '    }',
    '    clearPendingAgentEndCheck()',
    '    agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS',
    '    pendingAgentEndContext = ctx',
    '    pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, 0)',
    "    if (typeof pendingAgentEndCheck.unref === 'function') pendingAgentEndCheck.unref()",
    '  })',
    '}',
    ''
  ]
}
