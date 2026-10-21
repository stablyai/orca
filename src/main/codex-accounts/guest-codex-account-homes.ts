import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveHostCodexManagedHomeVerdict } from './host-codex-managed-home-ownership'

// Where the desktop creates a managed Codex account's home inside a guest (a WSL distro):
// `$HOME/<root>/<accountId>/home`, owned by an `.orca-managed-home` marker holding the id.
export const GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS = ['.local', 'share', 'orca', 'codex-accounts']

function guestCodexAccountsRoot(home: string): string {
  return join(home, ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS)
}

/** The canonical home when `candidate` is an Orca-owned account home on this host, else null. */
export function resolveGuestCodexAccountHome(
  candidate: string | undefined,
  home: string = homedir()
): string | null {
  const raw = candidate?.trim()
  if (!raw?.startsWith('/')) {
    return null
  }
  const path = resolve(raw)
  const root = guestCodexAccountsRoot(home)
  // Why lexical first: the path comes off the wire, and a stat of a stalled mount would block.
  if (basename(path) !== 'home' || dirname(dirname(path)) !== resolve(root)) {
    return null
  }
  const verdict = resolveHostCodexManagedHomeVerdict({
    candidatePath: path,
    managedAccountsRoot: root,
    systemCodexHomePath: getSystemCodexHomePath(),
    expectedAccountId: basename(dirname(path))
  })
  return verdict.kind === 'owned' ? verdict.homePath : null
}

/** Every Orca-owned account home on this host; none where the desktop never made one. */
export function listGuestCodexAccountHomes(home: string = homedir()): string[] {
  const root = guestCodexAccountsRoot(home)
  let accountIds: string[]
  try {
    accountIds = readdirSync(root)
  } catch {
    return []
  }
  const homes: string[] = []
  for (const accountId of accountIds) {
    const accountHome = resolveGuestCodexAccountHome(join(root, accountId, 'home'), home)
    if (accountHome) {
      homes.push(accountHome)
    }
  }
  return homes
}
