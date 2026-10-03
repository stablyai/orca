/**
 * Spec-level help for flags that mean the same thing across orchestration commands. Global flags
 * and --retry-request are described once in the shared flag table, not here.
 */
const SHARED_ORCHESTRATION_FLAG_HELP: Record<string, string> = {
  from: '<handle> Caller identity; defaults to this terminal or agent session',
  run: "<run_id> Run to act in instead of the caller's bound Run",
  'dispatch-capability': '<token> Dispatch capability token sent in the request envelope'
}

export function orchestrationFlagHelp(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return { ...SHARED_ORCHESTRATION_FLAG_HELP, ...overrides }
}
