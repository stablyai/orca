import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { configuredAdditionalCodexHomePaths } from '../../../ai-vault/discovery/ai-vault-scan-roots'
import { codexHomeSessionsDir } from '../../../ai-vault/discovery/session-scanner-roots'
import {
  assertOwnedHostCodexManagedHomePath,
  UntrustedManagedCodexHomeError
} from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import { GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS } from '../../../codex-accounts/managed-homes/guest-codex-account-homes'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { resolveHostCodexSessionSourceHome } from '../rollouts/codex-session-source-home'

/** Every Orca account home in a root; throws while one can't be read, since its copy may be in use. */
async function listAccountHomes(accountsRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(accountsRoot, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
  const homes: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const home = join(accountsRoot, entry.name, 'home')
    try {
      assertOwnedHostCodexManagedHomePath({
        candidatePath: home,
        managedAccountsRoot: accountsRoot,
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId: entry.name
      })
    } catch (error) {
      // Not Orca's (redirected or never set up): Orca neither launches nor links into it.
      if (error instanceof UntrustedManagedCodexHomeError) {
        continue
      }
      throw error
    }
    homes.push(home)
  }
  return homes
}

/**
 * Every host Codex home a rollout can have a name in, since history passes link it across all of
 * them: the user's, a custom history source, Orca's shared home and each account's. A WSL distro
 * keeps its own homes, and reading them can boot it.
 */
export async function listHostCodexRolloutHomes(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): Promise<string[]> {
  const candidates = [
    dirname(codexHomeSessionsDir()),
    getSystemCodexHomePath(),
    resolveHostCodexSessionSourceHome(settings),
    resolveOrcaManagedCodexHomePath(),
    ...(await listAccountHomes(join(getOrcaUserDataPath(), 'codex-accounts'))),
    // A headless host keeps its own accounts under the user's home.
    ...(await listAccountHomes(join(homedir(), ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS))),
    ...configuredAdditionalCodexHomePaths()
  ]
  const seen = new Set<string>()
  const homes: string[] = []
  for (const home of candidates) {
    if (!home || !isAbsolute(home) || parseWslUncPath(home)) {
      continue
    }
    const key = normalizeRuntimePathForComparison(home)
    if (!seen.has(key)) {
      seen.add(key)
      homes.push(home)
    }
  }
  return homes
}
