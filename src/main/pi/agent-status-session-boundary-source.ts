import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Runs belong to sessions; after replacement their children can no longer report to this registration.

// Pi replaces registrations for session switches and reloads.
function getPiSessionShutdownHandlerSourceLines(): string[] {
  return [
    "  onStatus('session_shutdown', (event) => {",
    '    clearPendingAgentEndCheck()',
    '    if (isOmpRuntime()) {',
    '      clearRunnerExitCheck()',
    '      resetPostQueue()',
    '      return',
    '    }',
    // Pi can tear down dialogs without resolving their promises or sending close events.
    '    piUiPromptDepth = 0',
    '    const reason = (event as { reason?: unknown } | null)?.reason',
    '    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile',
    // Reload/current-file resume retains session ownership and future child reports.
    "    const keepsSession = reason === 'reload' || (reason === 'resume' && typeof target === 'string' && target === sessionMetadata.session_file)",
    '    if (!keepsSession) clearRunnerExitCheck()',
    // PTY exit clears quit state; posting completion here would notify on every quit.
    "    if (keepsSession || reason === 'quit') {",
    // This queue outlives registration and could otherwise deliver stale status after its replacement.
    '      resetPostQueue()',
    '      return',
    '    }',
    // Older Pi lacks reasons; settle so orphaned children cannot hold the pane forever.
    '    closeOutRun(sessionMetadata.session_file)',
    // Child events can still arrive until Pi invalidates this registration.
    '    lifecycleState.onEvent = undefined',
    '  })',
    ''
  ]
}

export function getAgentStatusSessionBoundaryHandlerSourceLines(kind: PiAgentKind): string[] {
  return [
    ...(kind !== 'pi'
      ? [
          "  pi.on('session_shutdown', () => { resetSubagentRoster(); resetPostQueue(); clearPendingAgentEndCheck() })"
        ]
      : []),
    ...(kind !== 'prime-agent'
      ? [
          // OMP preserves registration/bus: new/branch cancel jobs, fork/resume retain their reports.
          '  const onOmpSessionChange = (event, ctx) => {',
          '    if (!isOmpRuntime()) return',
          "    if (event?.reason === 'fork' || event?.reason === 'resume') {",
          // Resume can interrupt a turn without agent_end.
          '      if (isTurnInFlight()) {',
          '        lifecycleState.endedRunGeneration = lifecycleState.runGeneration',
          '        postAgentEndOnce()',
          '      }',
          '    } else {',
          '      closeOutRun()',
          '    }',
          '    updateRuntimeOmpSessionMetadata(ctx)',
          '  }',
          "  pi.on('session_switch', onOmpSessionChange)",
          "  pi.on('session_branch', onOmpSessionChange)"
        ]
      : []),
    ...(kind === 'pi' ? getPiSessionShutdownHandlerSourceLines() : [])
  ]
}

export function getAgentStatusRunCloseOutSourceLines(): string[] {
  return [
    // pi-subagents reattaches parked runs and repeats their completion after resume.
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
    // Park children under their session file for resumed completion delivery.
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
