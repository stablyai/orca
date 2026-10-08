import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Mirrors the titlebar extension's dialog tracking so both agree on when the wait ends. */
export function getPiAgentStatusUiPromptHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    "  onStatus('ui_prompt_start', () => {",
    '    // Idle utility dialogs are not agent work; do not create a completion boundary for them.',
    '    if (isOmpRuntime() || !piTurnInFlight) return',
    '    piUiPromptDepth++',
    '    if (piUiPromptDepth > 1) return',
    "    post('ui_prompt_start')",
    '  })',
    '',
    "  onStatus('ui_prompt_end', (_event, ctx) => {",
    '    if (isOmpRuntime() || piUiPromptDepth === 0) return',
    '    piUiPromptDepth--',
    '    if (piUiPromptDepth > 0) return',
    '    // Why: ctx.isIdle throws outright once a session-switching modal invalidates the',
    '    // runner (it calls assertActive), so local turn state is the floor, not a fallback:',
    '    // with no turn in flight, no later event is coming to correct a working verdict, so',
    '    // only consult ctx when this process believes work is running.',
    '    let isIdle = !piTurnInFlight',
    '    try {',
    "      if (!isIdle && typeof ctx?.isIdle === 'function') isIdle = ctx.isIdle() === true",
    '    } catch {',
    '      // Why: a runner this very modal invalidated cannot answer; keep the local verdict.',
    '    }',
    '    // Why: Pi reports idle once its own turn settles, but children still hold the run open.',
    '    isIdle &&= !isHeldByChildren()',
    "    post('ui_prompt_end', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
