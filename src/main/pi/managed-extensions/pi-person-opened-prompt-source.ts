/** Pi fires ui_prompt_start for every ctx.ui.custom(), including viewers a person opens over a busy
 *  turn (/ps, log panels); Pi itself treats custom screens as non-blocking (docs/tui.md). A custom
 *  screen opened after terminal input, with no agent step since, is that person's, not a question.
 *  `on` registers a Pi event handler in the including extension's scope. */
export function getPiPersonOpenedPromptSourceLines(on: string): string[] {
  return [
    '  let piInputSinceAgentStep = false',
    '  let stopPiInputWatch = null',
    '  function stopPiTerminalInputWatch() {',
    '    try {',
    '      stopPiInputWatch?.()',
    '    } catch {}',
    '    stopPiInputWatch = null',
    '  }',
    `  ${on}('session_start', (_event, ctx) => {`,
    '    stopPiTerminalInputWatch()',
    '    piInputSinceAgentStep = false',
    '    try {',
    "      if (typeof ctx?.ui?.onTerminalInput !== 'function') return",
    '      stopPiInputWatch = ctx.ui.onTerminalInput(() => {',
    '        piInputSinceAgentStep = true',
    '        return undefined',
    '      })',
    '    } catch {}',
    '  })',
    `  ${on}('session_shutdown', () => stopPiTerminalInputWatch())`,
    // A permission dialog opens from tool_call, which follows tool_execution_start.
    "  for (const name of ['agent_start', 'turn_start', 'message_start', 'tool_execution_start', 'tool_execution_end']) {",
    `    ${on}(name, () => {`,
    '      piInputSinceAgentStep = false',
    '    })',
    '  }',
    '  function isPersonOpenedPiPrompt(event) {',
    "    return event?.kind === 'custom' && piInputSinceAgentStep",
    '  }',
    ''
  ]
}
