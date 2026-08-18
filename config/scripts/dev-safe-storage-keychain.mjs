import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// Must match getDevInstanceIdentity(true).appName — dev-instance-identity.test.ts pins the contract.
export const DEV_SAFE_STORAGE_APP_NAME = 'Orca Dev'

// `security` exits 45 (errSecDuplicateItem) when the (service, account) pair already exists.
const DUPLICATE_ITEM_EXIT_CODE = 45
const SECURITY_TIMEOUT_MS = 10_000
// Shorter: an open item answers in milliseconds, so this only bounds the blocked-on-a-prompt case.
const READ_PROBE_TIMEOUT_MS = 4_000

export function getDevSafeStorageKeychainNames(appName = DEV_SAFE_STORAGE_APP_NAME) {
  // Electron derives both from app.name; see safeStorage on macOS.
  return { service: `${appName} Safe Storage`, account: `${appName} Key` }
}

/** Copy-pasteable repair that keeps the existing password, so no dev secrets are lost. */
export function getDevSafeStorageRepairCommand(appName = DEV_SAFE_STORAGE_APP_NAME) {
  const { service, account } = getDevSafeStorageKeychainNames(appName)
  // Every lookup is scoped by account as well as service: matching on service alone picks an
  // arbitrary item when several share it, so a service-only delete can destroy a different credential.
  return `PW=$(security find-generic-password -a "${account}" -s "${service}" -w) && security delete-generic-password -a "${account}" -s "${service}" && security add-generic-password -a "${account}" -s "${service}" -w "$PW" -A`
}

function runSecurity(args, timeoutMs = SECURITY_TIMEOUT_MS) {
  // stdout is discarded so a probed password never enters this process.
  // Why the timeout: on a locked or ACL-restricted item `security` blocks on a GUI dialog, which
  // would hang `pnpm dev` startup indefinitely.
  execFileSync('/usr/bin/security', args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: timeoutMs
  })
}

/**
 * Whether the existing item is readable by a process other than the one that created it.
 *
 * Readability is the property we actually care about, and it is the only one observable here:
 * `dump-keychain -a` would expose the ACL directly but prompts per item on the login keychain.
 * An `-A` item answers instantly; an item whose ACL lists only one ad-hoc Electron bundle blocks
 * on the prompt until the timeout. That case does surface a dialog — but only when the developer
 * is already being prompted at app launch, and it converts a silent stuck state into an actionable one.
 */
function existingItemIsReadable(account, service, run) {
  try {
    // Scoped by account too: `add` collided on (service, account), so that exact pair is what must
    // be probed. A service-only match could validate a different item entirely.
    run(['find-generic-password', '-a', account, '-s', service, '-w'], READ_PROBE_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
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
    run(['add-generic-password', '-a', account, '-s', service, '-w', generatePassword(), '-A'])
    return { outcome: 'created', service }
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : null
    if (status !== DUPLICATE_ITEM_EXIT_CODE) {
      // Never surface error.message: execFileSync embeds the full argv, which includes
      // `-w <generated password>`, and the runner logs whatever we return here.
      return { outcome: 'failed', service, status }
    }
    // The item predates us — e.g. a run where provisioning failed and Electron created its own
    // with an ACL bound to that one branch's cdhash. Left unchecked, every later run would report
    // `exists` while the prompt kept coming back.
    return existingItemIsReadable(account, service, run)
      ? { outcome: 'exists', service }
      : { outcome: 'restricted', service }
  }
}
