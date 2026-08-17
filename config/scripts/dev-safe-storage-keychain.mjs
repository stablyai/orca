import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// Must match getDevInstanceIdentity(true).appName — dev-instance-identity.test.ts pins the contract.
export const DEV_SAFE_STORAGE_APP_NAME = 'Orca Dev'

// `security` exits 45 (errSecDuplicateItem) when the (service, account) pair already exists.
const DUPLICATE_ITEM_EXIT_CODE = 45

export function getDevSafeStorageKeychainNames(appName = DEV_SAFE_STORAGE_APP_NAME) {
  // Electron derives both from app.name; see safeStorage on macOS.
  return { service: `${appName} Safe Storage`, account: `${appName} Key` }
}

function runSecurity(args) {
  execFileSync('/usr/bin/security', args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

/**
 * Pre-create the dev safeStorage Keychain key with an unrestricted ACL (`-A`).
 *
 * Why: the dev runner re-signs a per-branch Electron bundle ad-hoc, so its designated
 * requirement is a bare cdhash that changes whenever the patched Info.plist changes.
 * Keychain ACLs are keyed by that requirement, so every new branch reads as a different
 * app and macOS blocks startup on a password prompt. Creating the item ourselves with
 * `-A` takes the code identity out of the decision entirely.
 *
 * Trade-off: any process running as this user can read this key without a prompt. Scoped
 * to the dev-only key — packaged builds derive a different service name from CFBundleName.
 */
export function ensureDevSafeStorageKeychainItem({
  appName = DEV_SAFE_STORAGE_APP_NAME,
  platform = process.platform,
  run = runSecurity,
  generatePassword = () => randomBytes(16).toString('base64')
} = {}) {
  if (platform !== 'darwin') {
    return { outcome: 'skipped' }
  }

  const { service, account } = getDevSafeStorageKeychainNames(appName)
  try {
    // Add-and-catch rather than check-then-add: concurrent `pnpm dev` runs race here, and
    // this way exactly one item wins instead of two probes both deciding to create it.
    // The password is a CLI arg (briefly visible in `ps`), which is not a meaningful
    // exposure for a key that is `-A` readable by any local process by design.
    run(['add-generic-password', '-a', account, '-s', service, '-w', generatePassword(), '-A'])
    return { outcome: 'created', service }
  } catch (error) {
    if (error?.status === DUPLICATE_ITEM_EXIT_CODE) {
      return { outcome: 'exists', service }
    }
    // Non-fatal: without the item Electron creates its own and macOS falls back to prompting.
    return { outcome: 'failed', service, error: error?.message ?? String(error) }
  }
}
