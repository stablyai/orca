import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

/** The package Orca's patch row names; DSH imports it from each profile. */
export const DSH_HOOK_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/** The DSH engine ships every executor peer except the hook protocol, so profiles must carry both. */
const DSH_HOOK_PACKAGES = [DSH_HOOK_EXECUTOR_PACKAGE, '@deepseek-ai/dsh-hook-protocol'] as const

/** Null when every DSH profile can load the row, or when DSH has not created a profile yet. */
export function describeDshProfilesMissingHookPackages(dshHome: string): string | null {
  const profilesDir = join(dshHome, 'profiles')
  let entries: string[]
  try {
    entries = readdirSync(profilesDir)
  } catch (error) {
    return isDefinitiveAbsence(error)
      ? null
      : `Could not read the DSH profiles directory ${profilesDir}`
  }
  const broken = entries
    .map((profile) => join(profilesDir, profile))
    .filter((profileDir) => existsSync(join(profileDir, 'package.json')))
    .map((profileDir) => ({
      profileDir,
      // DSH resolves the row only from the profile's own node_modules; a parent copy cannot reach engine peers.
      missing: DSH_HOOK_PACKAGES.filter(
        (pkg) => !existsSync(join(profileDir, 'node_modules', pkg, 'package.json'))
      )
    }))
    .filter(({ missing }) => missing.length > 0)
  if (broken.length === 0) {
    return null
  }
  const list = broken
    .map(({ profileDir, missing }) => `${profileDir} (missing ${missing.join(', ')})`)
    .join('; ')
  const install = DSH_HOOK_PACKAGES.map((pkg) => `${pkg}@<dsh version>`).join(' ')
  return `These DSH profiles cannot load Orca's hooks, so their sessions send no events to Orca: ${list}. Run \`pnpm add ${install}\` in each profile directory (npm latest is an older, incompatible line).`
}
