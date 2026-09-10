const ORCHESTRATION_FLAG_HELP = {
  help: 'Show this help message',
  json: 'Emit machine-readable JSON',
  'pairing-code': '<code> Connect using a one-time remote pairing code',
  environment: '<name> Target a saved remote Orca environment',
  from: '<handle> Terminal used as caller identity',
  run: '<run_id> Target an orchestration Run',
  'retry-request': '<id> Retry the exact mutation after an unknown result',
  'dispatch-capability': '<token> Authorize a Dispatch lifecycle action'
} satisfies Record<string, string>

export function orchestrationFlagHelp(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return { ...ORCHESTRATION_FLAG_HELP, ...overrides }
}
