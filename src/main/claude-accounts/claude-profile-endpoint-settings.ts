import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { writeSecureFile } from '../../shared/secure-file'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutOrcaHooks(value: Record<string, unknown>): string {
  return JSON.stringify(removeManagedHooks(value, getManagedScriptFileName()).config)
}

// Claude Code copies settings env over the process env, so these are overridden, not just
// dropped: a value exported by the user's shell would otherwise still apply.
const ENDPOINT_CLEARED_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  // May carry another service's credential, which must not reach this endpoint.
  ANTHROPIC_CUSTOM_HEADERS: '',
  CLAUDE_CODE_USE_BEDROCK: '0',
  CLAUDE_CODE_USE_VERTEX: '0',
  CLAUDE_CODE_USE_FOUNDRY: '0',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0',
  CLAUDE_CODE_USE_MANTLE: '0',
  CLAUDE_CODE_USE_GATEWAY: '0'
}

function settingsWithEndpoint(
  value: Record<string, unknown>,
  endpointEnv: Record<string, string>
): Record<string, unknown> {
  const env: Record<string, unknown> = isPlainRecord(value.env) ? value.env : {}
  const { apiKeyHelper: _apiKeyHelper, ...rest } = value
  return { ...rest, env: { ...env, ...ENDPOINT_CLEARED_ENV, ...endpointEnv } }
}

// The user's settings plus the endpoint env; written owner-only because it holds the token.
export function copySettingsWithEndpoint(
  source: string,
  target: string,
  endpointEnv: Record<string, string>
): ClaudeProfileSurfaceOutcome {
  const input = readClaudeProfileObject(source)
  if (input.kind === 'unavailable') {
    throw input.error
  }
  const desired = settingsWithEndpoint(input.kind === 'present' ? input.value : {}, endpointEnv)
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const current = readClaudeProfileObject(target)
  if (current.kind === 'present' && withoutOrcaHooks(desired) === withoutOrcaHooks(current.value)) {
    return 'unchanged'
  }
  // Restricts the file on Windows too, where a POSIX mode would be ignored.
  writeSecureFile(target, `${JSON.stringify(desired, null, 2)}\n`)
  return 'synced'
}
