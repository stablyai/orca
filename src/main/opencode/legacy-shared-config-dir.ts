import { join, resolve } from 'node:path'

export const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
export const OPENCODE2_LEGACY_HOOKS_DIR = 'opencode2-hooks'

// Why: before 1.4.209 Orca pointed OPENCODE_CONFIG_DIR at this dir; shells and OpenCode 2 background services from then can still load it.
export function getOpenCodeLegacySharedConfigDir(
  userDataPath: string,
  legacyHooksDir: string
): string {
  return join(userDataPath, legacyHooksDir, 'shared')
}

export function isOpenCodeLegacySharedConfigDir(
  configDir: string | undefined,
  userDataPath: string
): boolean {
  return (
    configDir !== undefined &&
    [OPENCODE_LEGACY_HOOKS_DIR, OPENCODE2_LEGACY_HOOKS_DIR].some(
      (hooksDir) =>
        normalizeConfigPath(configDir) ===
        normalizeConfigPath(getOpenCodeLegacySharedConfigDir(userDataPath, hooksDir))
    )
  )
}

function normalizeConfigPath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const OPENCODE_CONFIG_DIR_ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
] as const

/** Carries retired inherited paths through providers that merge their environment later. */
export function getLegacyOpenCodeEnvKeysToDelete(
  env: Record<string, string | undefined> | undefined,
  userDataPath: string,
  inherited: Record<string, string | undefined> = process.env
): string[] {
  return OPENCODE_CONFIG_DIR_ENV_KEYS.filter((key) =>
    isOpenCodeLegacySharedConfigDir(env?.[key] ?? inherited[key], userDataPath)
  )
}
