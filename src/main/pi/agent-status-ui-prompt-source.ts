import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Pi owns nested prompt depth and emits one pair around select/confirm/input/editor/custom. */
export function getPiAgentStatusUiPromptHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    "  pi.on('ui_prompt_start', () => {",
    '    if (isOmpRuntime()) return',
    '    piUiPromptActive = true',
    "    post('ui_prompt_start')",
    '  })',
    '',
    "  pi.on('ui_prompt_end', (_event, ctx) => {",
    '    if (isOmpRuntime() || !piUiPromptActive) return',
    '    piUiPromptActive = false',
    "    post('ui_prompt_end', { is_idle: ctx?.isIdle?.() === true })",
    '  })',
    ''
  ]
}
