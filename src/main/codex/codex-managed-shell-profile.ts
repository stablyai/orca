import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaUserDataPath, resolveOrcaManagedCodexHomePath } from './codex-home-paths'
import { editTomlStringSetting } from './config-toml-string-setting'

const PROFILE_PATH = ['shell_environment_policy', 'set', 'ORCA_USER_DATA_PATH']

export function applyManagedCodexShellProfile(
  content: string,
  homes: {
    runtimeHomePath: string
    systemHomePath: string
    systemConfigDir?: string
  }
): string {
  if (
    parseWslUncPath(homes.runtimeHomePath) ||
    parseWslUncPath(homes.systemHomePath) ||
    homes.systemConfigDir
  ) {
    return content
  }
  const userDataPath = getOrcaUserDataPath()
  const runtimeHome = resolve(homes.runtimeHomePath)
  if (runtimeHome === resolve(homes.systemHomePath)) {
    return content
  }
  let isOwnedSharedHome = false
  if (runtimeHome === resolveOrcaManagedCodexHomePath()) {
    // A redirected shared home must never inject runtime identity into the user's real home.
    isOwnedSharedHome =
      realpathSync(runtimeHome) === join(realpathSync(userDataPath), 'codex-runtime-home', 'home')
  }
  const isOwnedAccountHome =
    !isOwnedSharedHome &&
    resolveHostCodexManagedHomeVerdict({
      candidatePath: runtimeHome,
      managedAccountsRoot: join(userDataPath, 'codex-accounts'),
      systemCodexHomePath: homes.systemHomePath
    }).kind === 'owned'
  return isOwnedSharedHome || isOwnedAccountHome
    ? editTomlStringSetting(content, PROFILE_PATH, userDataPath)
    : content
}

export function stripManagedCodexShellProfile(content: string): string {
  return editTomlStringSetting(content, PROFILE_PATH, null)
}
