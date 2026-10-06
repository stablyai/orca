import { CLAUDE_AUTH_ENV_VARS, applyClaudeEnvPatch } from '../claude-accounts/environment'
import { stripClaudeProfileProviderEnvironment } from '../claude-accounts/claude-profile-environment'

const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID'
] as const

export function cloneClaudeProcessEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

function stripClaudeChildSessionStamps(
  env: Record<string, string>,
  platform: NodeJS.Platform
): Record<string, string> {
  for (const key of CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS) {
    for (const envKey of Object.keys(env)) {
      if (envKey === key || (platform === 'win32' && envKey.toUpperCase() === key)) {
        delete env[envKey]
      }
    }
  }
  return env
}

export function buildClaudeChildProcessEnv(
  configuredEnv: Record<string, string> = {},
  options: {
    inheritedEnv?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    scrubConfiguredChildSessionStamps?: boolean
    isolatedCredentials?: boolean
    envToDelete?: readonly string[]
  } = {}
): Record<string, string> {
  const inheritedEnv = options.inheritedEnv ?? process.env
  const platform = options.platform ?? process.platform
  const env = applyClaudeEnvPatch(
    cloneClaudeProcessEnvironment(inheritedEnv),
    {},
    {
      stripAuthEnv: true,
      platform
    }
  )
  if (platform === 'win32') {
    const authKeys = new Set(CLAUDE_AUTH_ENV_VARS.map((key) => key.toUpperCase()))
    for (const [key, value] of Object.entries(env)) {
      const normalized = key.toUpperCase()
      if (
        authKeys.has(normalized) ||
        (normalized === 'ANTHROPIC_CUSTOM_HEADERS' &&
          /authorization|x-api-key|api-key|bearer/i.test(value))
      ) {
        delete env[key]
      }
    }
  }
  if (!options.scrubConfiguredChildSessionStamps) {
    stripClaudeChildSessionStamps(env, platform)
  }
  const merged = { ...env, ...configuredEnv }
  const deleted = new Set(options.envToDelete?.map((key) => key.toUpperCase()))
  for (const key of Object.keys(merged)) {
    if (deleted.has(key.toUpperCase())) {
      delete merged[key]
    }
  }
  if (options.scrubConfiguredChildSessionStamps) {
    if (options.isolatedCredentials) {
      stripClaudeProfileProviderEnvironment(merged)
    }
    return stripClaudeChildSessionStamps(merged, platform)
  }
  return merged
}
