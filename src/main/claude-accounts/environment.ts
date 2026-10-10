import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'

export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

export type ClaudeEnvPatch = {
  [CLAUDE_PROFILE_POINTER_ENV]?: string
  [CLAUDE_INJECTED_CONFIG_DIR_ENV]?: string
  [CLAUDE_USER_CONFIG_DIR_ENV]?: string
  CLAUDE_CONFIG_DIR?: string
  ANTHROPIC_CUSTOM_HEADERS?: string
}

export function applyClaudeEnvPatch(
  baseEnv: Record<string, string>,
  patch: ClaudeEnvPatch,
  options?: { stripAuthEnv?: boolean; platform?: NodeJS.Platform }
): Record<string, string> {
  if (options?.stripAuthEnv) {
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      delete baseEnv[key]
    }
    const platform = options.platform ?? process.platform
    for (const key of Object.keys(baseEnv)) {
      const normalized = platform === 'win32' ? key.toUpperCase() : key
      if (
        (platform === 'win32' && CLAUDE_AUTH_ENV_VARS.some((authKey) => authKey === normalized)) ||
        (normalized === 'ANTHROPIC_CUSTOM_HEADERS' && isAuthLikeCustomHeaders(baseEnv[key]))
      ) {
        delete baseEnv[key]
      }
    }
  }

  for (const key of [
    CLAUDE_PROFILE_POINTER_ENV,
    CLAUDE_INJECTED_CONFIG_DIR_ENV,
    CLAUDE_USER_CONFIG_DIR_ENV
  ] as const) {
    const value = patch[key]
    if (value) {
      baseEnv[key] = value
    }
  }
  if (patch.CLAUDE_CONFIG_DIR) {
    baseEnv.CLAUDE_CONFIG_DIR = patch.CLAUDE_CONFIG_DIR
  }
  if (patch.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
    baseEnv.ANTHROPIC_CUSTOM_HEADERS = patch.ANTHROPIC_CUSTOM_HEADERS
  }

  return baseEnv
}

/** Whether the selected account is a host-managed one; an id no account explains counts as one. */
export function isHostManagedClaudeAccount(
  accounts: readonly ClaudeManagedAccount[] | undefined,
  activeAccountId: string | null | undefined
): boolean {
  if (!activeAccountId) {
    return false
  }
  return (
    (accounts ?? []).find((account) => account.id === activeAccountId)?.managedAuthRuntime !== 'wsl'
  )
}

function isAuthLikeCustomHeaders(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return /authorization|x-api-key|api-key|bearer/i.test(value)
}
