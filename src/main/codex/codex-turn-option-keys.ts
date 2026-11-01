/** Allowlist turn overrides so saved options cannot replace the thread's permission policy. */
const CODEX_TURN_OPTION_KEYS = new Set(['model', 'effort', 'personality', 'serviceTier'])

export function isCodexTurnOptionKey(key: string): boolean {
  return CODEX_TURN_OPTION_KEYS.has(key)
}
