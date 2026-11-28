import { OMP_VIBE_LAUNCH_COMMAND } from '../../../../shared/agent-launch/startup/omp-vibe-launch-prompt'

// Argv launch prompts reach session.prompt, which runs extension commands but not OMP's TUI-only /vibe.
export function getOmpVibeCommandSourceLines(): string[] {
  return [
    "  if (isOmpRuntime() && typeof pi.registerCommand === 'function') {",
    `    pi.registerCommand('${OMP_VIBE_LAUNCH_COMMAND}', {`,
    "      description: 'Enter vibe mode, then send the prompt (launched from Orca)',",
    '      handler: async (prompt, ctx) => {',
    '        const modes = ctx?.sessionModes',
    "        if (!modes || typeof modes.set !== 'function') {",
    "          ctx?.ui?.notify?.('This OMP version cannot enter vibe mode for Orca. Run /vibe instead.', 'error')",
    '          return',
    '        }',
    "        const result = await modes.set({ mode: 'vibe', action: 'enter' })",
    '        if (!result?.ok) {',
    "          ctx?.ui?.notify?.('Could not enter vibe mode: ' + (result?.message ?? 'unknown error'), 'error')",
    '          return',
    '        }',
    '        const text = String(prompt ?? \'\').trim()',
    "        if (text && typeof pi.sendUserMessage === 'function') pi.sendUserMessage(text)",
    '      }',
    '    })',
    '  }'
  ]
}
