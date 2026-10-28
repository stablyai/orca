import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { codexConversationStore, discoverCodexStoreHomes } from '../codex/codex-launch-home'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveHostCodexManagedHomeVerdict } from './host-codex-managed-home-ownership'

// Guest homes use $HOME/<root>/<accountId>/home with an account-ID ownership marker.
export const GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS = ['.local', 'share', 'orca', 'codex-accounts']

function guestCodexAccountsRoot(home: string): string {
  return join(home, ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS)
}

export function resolveGuestCodexAccountHome(
  candidate: string | undefined,
  home: string = homedir()
): string | null {
  const raw = candidate?.trim()
  if (!raw?.startsWith('/')) {
    return null
  }
  const candidatePath = resolve(raw)
  const overlay = basename(dirname(candidatePath)) === 'overlays'
  const path = overlay ? join(dirname(dirname(candidatePath)), 'home') : candidatePath
  const root = guestCodexAccountsRoot(home)
  if (basename(path) !== 'home' || dirname(dirname(path)) !== resolve(root)) {
    return null
  }
  if (overlay && !/^[a-f0-9]{32}$/.test(basename(candidatePath))) {
    return null
  }

  const verdict = resolveHostCodexManagedHomeVerdict({
    candidatePath: path,
    managedAccountsRoot: root,
    systemCodexHomePath: getSystemCodexHomePath(),
    expectedAccountId: basename(dirname(path))
  })
  if (verdict.kind !== 'owned') {
    return null
  }
  if (overlay) {
    try {
      codexConversationStore(candidatePath)
    } catch {
      return null
    }
  }
  return candidatePath
}

export function listGuestCodexAccountHomes(home: string = homedir()): string[] {
  const root = guestCodexAccountsRoot(home)
  return discoverCodexStoreHomes(root)
}
