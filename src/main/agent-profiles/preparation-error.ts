// Only fixed public reasons cross provider callback boundaries; arbitrary errors stay sanitized.
const REASONS = {
  claude_identity:
    'The canonical Claude login no longer verifies this managed account identity. Reconnect the account before launching.',
  claude_config:
    'Managed Claude profiles require direct Claude OAuth. Remove competing authentication or provider settings, or connect this home as an external profile.',
  claude_policy:
    'Orca cannot verify managed Claude authentication under this policy. Use an external profile or a host with verifiable local configuration.',
  codex_config:
    'Managed Codex profiles require direct OpenAI OAuth and file credentials. Remove provider, endpoint, or credential-store overrides, or connect this home as an external profile.',
  codex_policy:
    'Orca cannot verify managed Codex authentication under this enterprise policy. Use an external profile or a host with verifiable local configuration.'
} as const
export class AgentProfilePreparationError extends Error {
  constructor(readonly code: keyof typeof REASONS) {
    super(REASONS[code])
  }
}
export function sanitizedProfilePreparationError(error: unknown, fallback: string): Error {
  return error instanceof AgentProfilePreparationError
    ? new AgentProfilePreparationError(error.code)
    : new Error(fallback)
}
