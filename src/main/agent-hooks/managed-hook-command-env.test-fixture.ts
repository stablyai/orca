export const GROK_PROVIDED_HOOK_VARIABLES = [
  'GROK_HOOK_EVENT',
  'GROK_HOOK_NAME',
  'GROK_SESSION_ID',
  'GROK_WORKSPACE_ROOT',
  'CLAUDE_PROJECT_DIR'
] as const

const providedVariables = new Set<string>(GROK_PROVIDED_HOOK_VARIABLES)

export function findBareHookCommandVariables(command: string): string[] {
  // Why: Grok scans dollar bytes without shell quoting state, even inside single quotes.
  // These are the two runtime-home assertions from installer-utils.test.ts, shared across builders.
  const references = [
    ...command.matchAll(/\$(?!\{)([A-Za-z_][A-Za-z0-9_]*)/g),
    ...command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)
  ]
  return references
    .values()
    .filter((match) => !providedVariables.has(match[1]))
    .map((match) => match[0])
    .toArray()
}
