/** Update fields the runtime copies onto a stored automation when the caller sent them. */
export const RUNTIME_AUTOMATION_PATCH_KEYS = [
  'name',
  'prompt',
  'precheck',
  'agentId',
  'extraAgentArgs',
  'launchSetupPatch',
  'runContext',
  'sourceContext',
  'baseBranch',
  'setupDecision',
  'setupTrustHash',
  'reuseSession',
  'onNoReusableSession',
  'timezone',
  'rrule',
  'dtstart',
  'enabled',
  'missedRunGraceMinutes'
] as const
