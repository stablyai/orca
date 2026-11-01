import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutOrcaHooks(value: Record<string, unknown>): string {
  return JSON.stringify(removeManagedHooks(value, getManagedScriptFileName()).config)
}

// Settings that would send an endpoint account's requests elsewhere or with another credential.
const ENDPOINT_CONFLICTING_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
] as const

function settingsWithEndpoint(
  value: Record<string, unknown>,
  endpointEnv: Record<string, string>
): Record<string, unknown> {
  const env: Record<string, unknown> = isPlainRecord(value.env) ? { ...value.env } : {}
  for (const key of ENDPOINT_CONFLICTING_ENV) {
    delete env[key]
  }
  const { apiKeyHelper: _apiKeyHelper, ...rest } = value
  return { ...rest, env: { ...env, ...endpointEnv } }
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
  writeFileAtomically(target, `${JSON.stringify(desired, null, 2)}\n`, {
    mode: 0o600
  })
  return 'synced'
}
