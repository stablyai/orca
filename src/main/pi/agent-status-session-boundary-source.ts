import type { PiAgentKind } from '../../shared/pi-agent-kind'

export function getAgentStatusSessionStartHandlerSourceLines(kind: PiAgentKind): string[] {
  return kind !== 'omp'
    ? [
        "  onStatus('session_start', (event, ctx) => {",
        '    updateSessionMetadata(ctx)',
        '    if (isOmpRuntime()) { invalidateOmpUiDialogs(); post("session_start", readOmpActivity(ctx)); return }',
        ...(kind === 'pi' ? ['    piUiPromptDepth = 0'] : []),
        '    // Why: /reload re-registers the active session, but it is not a',
        '    // turn boundary and must not clear the visible status or unread state.',
        "    if (event.reason === 'reload') return",
        "    post('session_start')",
        ...(kind === 'pi'
          ? [
              '    restoreParkedSubagents()',
              // Why: the host reads session_start as an idle session; children still hold this one.
              "    if (lifecycleState.waiting) post('agent_start')"
            ]
          : []),
        '  })',
        ''
      ]
    : [
        "  onStatus('session_start', (_event, ctx) => {",
        '    invalidateOmpUiDialogs()',
        '    updateRuntimeOmpSessionMetadata(ctx)',
        "    post('session_start', readOmpActivity(ctx))",
        '  })'
      ]
}

// What the generated extension does when a session ends or is replaced. A run belongs to one
// session: once that session is gone its children never report here again, so the run ends with it.

// Pi replaces the registration for /new, resume and fork, and again for /reload, which keeps the session.
function getPiSessionShutdownHandlerSourceLines(): string[] {
  return [
    "  onStatus('session_shutdown', (event) => {",
    '    clearPendingAgentEndCheck()',
    '    if (isOmpRuntime()) {',
    '      invalidateOmpUiDialogs()',
    '      ompCompletionExtra = {}',
    '      ompCompletionContext = null',
    '      clearRunnerExitCheck()',
    '      resetPostQueue()',
    '      return',
    '    }',
    // Why: pi tears an open dialog down without resolving its promise, so no ui_prompt_end follows.
    '    piUiPromptDepth = 0',
    '    const reason = (event as { reason?: unknown } | null)?.reason',
    '    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile',
    // Why: /reload and a resume of the file already open keep the session, and its children still report to it.
    "    const keepsSession = reason === 'reload' || (reason === 'resume' && typeof target === 'string' && target === sessionMetadata.session_file)",
    '    if (!keepsSession) clearRunnerExitCheck()',
    // Why: on quit the PTY's exit clears the pane, and a done here would notify on every quit.
    "    if (keepsSession || reason === 'quit') {",
    // Why: this registration's queue outlives it and would deliver stale posts after the next one's.
    '      resetPostQueue()',
    '      return',
    '    }',
    // Also a Pi too old to give a reason: its children would otherwise hold the pane for good.
    '    closeOutRun(sessionMetadata.session_file)',
    // Why: pi-subagents can still emit here until Pi invalidates this registration.
    '    lifecycleState.onEvent = undefined',
    '  })',
    ''
  ]
}

// Registered after onStatus exists; expects the roster and closeOutRun() from the handler scope.
export function getAgentStatusSessionBoundaryHandlerSourceLines(kind: PiAgentKind): string[] {
  return [
    ...(kind !== 'pi'
      ? [
          "  onStatus('session_shutdown', () => { resetSubagentRoster(); resetPostQueue(); clearPendingAgentEndCheck(); invalidateOmpUiDialogs(); ompCompletionExtra = {}; ompCompletionContext = null })"
        ]
      : []),
    ...(kind !== 'prime-agent'
      ? [
          // Why: OMP keeps this registration and bus across a switch. /new and a branch cancel the
          // session's own jobs; fork and resume (which is also how it reloads) leave them running
          // and reporting here.
          '  const onOmpSessionChange = (event, ctx) => {',
          '    if (!isOmpRuntime()) return',
          '    clearPendingAgentEndCheck()',
          '    invalidateOmpUiDialogs()',
          '    ompCompletionExtra = {}',
          '    ompCompletionContext = null',
          "    if (event?.reason === 'fork' || event?.reason === 'resume') {",
          // Why: a resume cuts a running turn off without an agent_end.
          '      if (isTurnInFlight()) {',
          '        lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
          '        postAgentEndOnce()',
          '      }',
          '    } else {',
          '      closeOutRun()',
          '    }',
          '    updateRuntimeOmpSessionMetadata(ctx)',
          "    post('session_switch', { ...readOmpActivity(ctx), ...(isHeldByChildren() ? { has_active_jobs: true } : {}) })",
          '  }',
          "  onStatus('session_switch', onOmpSessionChange)",
          "  onStatus('session_branch', onOmpSessionChange)"
        ]
      : []),
    ...(kind === 'pi' ? getPiSessionShutdownHandlerSourceLines() : [])
  ]
}

export function getAgentStatusRunCloseOutSourceLines(): string[] {
  return [
    // Why: pi-subagents re-attaches a resumed session's runs and reports their completion to it.
    '  function restoreParkedSubagents(): void {',
    '    const file = sessionMetadata.session_file',
    "    if (typeof file !== 'string') return",
    '    const parked = lifecycleState.parked?.get(file)',
    '    if (!parked) return',
    '    lifecycleState.parked?.delete(file)',
    '    for (const [id, detail] of parked) {',
    '      lifecycleState.active.add(id)',
    '      subagentDetails.set(id, detail)',
    '    }',
    '    if (!isHeldByChildren()) return',
    '    lifecycleState.waiting = true',
    '    lifecycleState.completionPostedGeneration = -1',
    '  }',
    '',
    // `parkUnder` keeps the children for a resume into that session file, where pi-subagents
    // announces each one's completion again.
    '  function closeOutRun(parkUnder?: unknown): void {',
    '    const unsettled = lifecycleState.waiting || isTurnInFlight()',
    "    if (typeof parkUnder === 'string' && isHeldByChildren()) {",
    '      const parked = new Map<string, SubagentDetail>()',
    '      for (const id of lifecycleState.active) {',
    '        const detail = subagentDetails.get(id)',
    '        if (detail && !lifecycleState.exited?.has(id)) parked.set(id, detail)',
    '      }',
    '      ;(lifecycleState.parked ??= new Map()).set(parkUnder, parked)',
    '    }',
    '    resetSubagentRoster()',
    '    resetPostQueue()',
    '    if (!unsettled) return',
    '    lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
    '    postAgentEndOnce(true)',
    '  }',
    ''
  ]
}
