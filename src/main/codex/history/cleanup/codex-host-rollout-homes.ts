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
  UntrustedManagedCodexHomeError,
  type CodexAccountHomeCandidate
} from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'
import { GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS } from '../../../codex-accounts/managed-homes/guest-codex-account-homes'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { resolveHostCodexSessionSourceHome } from '../rollouts/codex-session-source-home'

/** Each account folder in a root, before its ownership is checked (a sync read, so done off main). */
async function listAccountHomeCandidates(
  accountsRoot: string
): Promise<CodexAccountHomeCandidate[]> {
  let entries
  try {
    entries = await readdir(accountsRoot, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
  return (
    entries
      // A relocated account folder is a link; ownership checks where it resolves.
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ accountsRoot, accountId: entry.name }))
  )
}

/** The candidates' homes Orca owns; one that can't be read throws, since its copy may be in use. */
function ownedAccountHomes(candidates: readonly CodexAccountHomeCandidate[]): string[] {
  const homes: string[] = []
  for (const { accountsRoot, accountId } of candidates) {
    const home = join(accountsRoot, accountId, 'home')
    try {
      assertOwnedHostCodexManagedHomePath({
        candidatePath: home,
        managedAccountsRoot: accountsRoot,
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId: accountId
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

function uniqueHostHomes(candidates: readonly (string | undefined)[]): string[] {
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

/**
 * The host Codex homes besides Orca's account homes, plus those account folders unchecked, so a
 * caller can verify their ownership (sync reads) where blocking is fine. Leaves out the extra homes
 * session discovery adds: they are these same homes, found through a sync ownership check.
 */
export async function listHostCodexRolloutHomeSources(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): Promise<{ homes: string[]; accounts: CodexAccountHomeCandidate[] }> {
  return {
    homes: uniqueHostHomes([
      dirname(codexHomeSessionsDir()),
      getSystemCodexHomePath(),
      resolveHostCodexSessionSourceHome(settings),
      resolveOrcaManagedCodexHomePath()
    ]),
    accounts: [
      ...(await listAccountHomeCandidates(join(getOrcaUserDataPath(), 'codex-accounts'))),
      // A headless host keeps its own accounts under the user's home.
      ...(await listAccountHomeCandidates(join(homedir(), ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS)))
    ]
  }
}

/**
 * The host Codex homes Orca may delete rollouts from: the user's, Orca's shared home and each
 * account's, plus the import folder as a root no deletion may reach. A WSL distro keeps its own
 * homes, and reading them can boot it.
 */
export async function listHostCodexRolloutHomes(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): Promise<{ homes: string[]; protectedRoots: string[] }> {
  const { accounts } = await listHostCodexRolloutHomeSources(settings)
  const importFolder = resolveHostCodexSessionSourceHome(settings)
  return {
    // Only Orca's own homes: the import folder is the user's, even when it holds the same chats.
    homes: uniqueHostHomes([
      dirname(codexHomeSessionsDir()),
      getSystemCodexHomePath(),
      resolveOrcaManagedCodexHomePath(),
      ...ownedAccountHomes(accounts),
      ...configuredAdditionalCodexHomePaths()
    ]),
    // Kept even inside WSL: a host folder can link into it.
    protectedRoots:
      importFolder && (isAbsolute(importFolder) || parseWslUncPath(importFolder))
        ? [importFolder]
        : []
  }
}
