import { getOmpModelCommandSourceLines } from './omp-model-command-source'
import { getPiPrefillHandlerSourceLines } from './prefill-extension-source'
import { getAgentStatusInputRedactionSourceLines } from './agent-status-input-redaction-source'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { getOmpSessionOwnerHandlerSourceLines } from './omp-session-status-owner-source'
import { getOmpPlanReviewHandlerSourceLines } from './omp-plan-review-source'
import { getPiAgentStatusUiPromptHandlerSourceLines } from './agent-status-ui-prompt-source'
import { getPiAgentStatusCompactionHandlerSourceLines } from './agent-status-compaction-source'
import {
  getPiSubagentRosterEventSourceLines,
  getPiSubagentRosterSetupSourceLines
} from './agent-status-subagent-roster-source'
import {
  getAgentStatusRunCloseOutSourceLines,
  getAgentStatusSessionBoundaryHandlerSourceLines
} from './agent-status-session-boundary-source'

export function getPiAgentStatusHandlerSourceLines(kind: PiAgentKind): string[] {
  const sessionStartHandler =
    kind !== 'omp'
      ? [
          "  onStatus('session_start', (event, ctx) => {",
          '    updateSessionMetadata(ctx)',
          ...(kind === 'pi' ? ['    piUiPromptDepth = 0'] : []),
          '    // Reload replaces registration without ending the turn; preserve status and unread state.',
          "    if (event.reason === 'reload') return",
          "    post('session_start')",
          ...(kind === 'pi'
            ? [
                '    replyFinishedAt = undefined',
                '    restoreParkedSubagents()',
                // session_start reports idle; restore busy status while children still own the run.
                "    if (lifecycleState.waiting) post('agent_start')"
              ]
            : []),
          '  })',
          ''
        ]
      : []

  // OMP switches in-process, so every post needs current session identity.
  const ctxParam = ', ctx'
  const bareCtxParams = '_event, ctx'
  const captureSessionMetadata = ['    updateRuntimeOmpSessionMetadata(ctx)']
  const primeDaemonWorkerGuard =
    kind === 'prime-agent'
      ? [
          '  // Prime loads this in frontend and daemon; only the event-emitting daemon reports.',
          '  if (!process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER) return'
        ]
      : []
  const ownerEnv = kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'

  // OMP emits permission-wait lifecycle only with listeners; Prime has no such runtime.
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

  // OMP wraps Pi, so future Pi model_select events can report between-turn switches.
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
    '// Preview only assistant text; reasoning and tool parts have separate surfaces.',
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
    '// Reclaim inherited dead owner PIDs only on ESRCH; all other probe results must suppress duplicate reporting.',
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
    '// Inherited pane identity permits only the lead process; PID equality retains in-process reloads.',
    'export default function (pi): void {',
    ...primeDaemonWorkerGuard,
    `  const ownerPid = process.env.${ownerEnv}`,
    '  const selfPid = String(process.pid)',
    '  if (ownerPid && ownerPid !== selfPid && isStatusOwnerAlive(ownerPid)) return',
    `  process.env.${ownerEnv} = selfPid`,
    '  resetPostQueue()',
    ...getPiSubagentRosterSetupSourceLines(kind),
    ...getOmpSessionOwnerHandlerSourceLines(),
    ...getAgentStatusSessionBoundaryHandlerSourceLines(kind),
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
    '    lifecycleState.runGeneration += 1',
    // Turn start proves no input-holding modal remains; recover missing dialog-close events.
    ...(kind === 'pi'
      ? ['    piUiPromptDepth = 0', '    piTurnInFlight = true', '    replyFinishedAt = undefined']
      : []),
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
    ...(kind === 'prime-agent' ? [] : getOmpPlanReviewHandlerSourceLines()),
    ...getPiAgentStatusUiPromptHandlerSourceLines(kind),
    ...getPiAgentStatusCompactionHandlerSourceLines(kind),
    ...modelSelectHandler,
    '  // message_end finalizes preview text before agent_end, so dashboards see the latest reply sooner.',
    `  onStatus('message_end', (event${ctxParam}) => {`,
    ...captureSessionMetadata,
    "    if (event.message?.role !== 'assistant') return",
    '    const text = extractAssistantText(event.message)',
    '    if (!text) return',
    "    post('message_end', { role: 'assistant', text })",
    '  })',
    '',
    '  // Modern Pi stays busy through retry/compaction; OMP willContinue bypasses this legacy-idle recheck.',
    '  const AGENT_END_IDLE_RECHECK_MS = 25',
    '  const AGENT_END_IDLE_RECHECK_MAX_MS = 250',
    '  let agentSettledSupported = false',
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
    // Exited child runners retain ownership through their grace period.
    '  function isHeldByChildren(): boolean {',
    '    return lifecycleState.active.size > 0',
    '  }',
    '',
    '  function isTurnInFlight(): boolean {',
    '    return lifecycleState.runGeneration !== lifecycleState.endedRunGeneration',
    '  }',
    '',
    '  function postAgentEndOnce(final = false): boolean {',
    '    for (const id of lifecycleState.exited ?? []) forgetSubagent(id)',
    '    if (isHeldByChildren()) {',
    '      lifecycleState.waiting = true',
    '      return false',
    '    }',
    '    lifecycleState.waiting = false',
    '    if (lifecycleState.completionPostedGeneration === lifecycleState.endedRunGeneration) return false',
    '    lifecycleState.completionPostedGeneration = lifecycleState.endedRunGeneration',
    // Separate from completion generation: a fresh pane without a turn is idle.
    ...(kind === 'pi' ? ['    piTurnInFlight = false'] : []),
    // Session boundary is not successful completion; record it quietly.
    ...(kind === 'pi'
      ? [
          '    const replyFields = takeCompletedReplyFields()',
          "    post('agent_end', final ? { session_boundary: true } : replyFields, final)"
        ]
      : ["    post('agent_end', final ? { session_boundary: true } : {}, final)"]),
    '    return true',
    '  }',
    '',
    ...getAgentStatusRunCloseOutSourceLines(),
    '  function checkPendingAgentEnd(): void {',
    '    pendingAgentEndCheck = null',
    '    const ctx = pendingAgentEndContext',
    '    if (!ctx || agentSettledSupported || lifecycleState.completionPostedGeneration === lifecycleState.endedRunGeneration) {',
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
    '    lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
    ...(kind === 'pi' ? ['    recordReplyFinish(event)'] : []),
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
