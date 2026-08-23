import { getSecretStore } from '../../shared/secret-store'

/**
 * Report at-rest secret protection once at startup.
 *
 * Why this exists: the port has always been able to describe a protection gap, and
 * nothing read it — so a Linux user whose secrets are obfuscated with a built-in key
 * was told nothing at all. Reading it here is the difference between the port
 * documenting a promise and keeping one.
 *
 * Deliberately not fatal and not a dialog: sealing still works, so blocking startup
 * would be worse than the gap it reports.
 */
export function reportSecretProtectionGap(
  log: (message: string) => void = (message) => console.warn(message)
): string | null {
  let gap: string | null
  try {
    gap = getSecretStore().describeProtectionGap()
  } catch (error) {
    // Why swallow: this is diagnostics. An uninstalled store is already a hard failure
    // at the first real read, and that error is the useful one.
    log(`[secrets] could not determine at-rest protection: ${String(error)}`)
    return null
  }
  if (gap) {
    log(`[secrets] ${gap}`)
  }
  return gap
}
