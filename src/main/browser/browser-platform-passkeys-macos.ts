import { runProcessSync } from '../../shared/child-process/run-process'

// Why: GitHub and other relying parties gate passkey sign-in on
// PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(). Electron
// reports false until the app opts into the Touch ID authenticator, and a
// discoverable-credential request then waits on USB security keys for the
// three-minute Chromium floor. Opting in makes the check true, shows the Touch
// ID sheet, and lets a request with no matching passkey fail promptly.

export const ORCA_WEBAUTHN_KEYCHAIN_GROUP_SUFFIX = '.webauthn'

type PlatformPasskeyApp = {
  isPackaged: boolean
  configureWebAuthn?: (options: {
    touchID: { keychainAccessGroup: string; promptReason?: string }
  }) => void
}

export type PlatformPasskeyOutcome =
  | { status: 'enabled'; keychainAccessGroup: string }
  | { status: 'skipped'; reason: 'not-macos' | 'unpackaged' | 'api-unavailable' | 'no-entitlement' }
  | { status: 'failed'; error: string }

/**
 * Picks the WebAuthn keychain group out of the executable's signed entitlements.
 * Why read the signature and not a build constant: the Touch ID authenticator only
 * works when the running binary actually carries the group, so the signature is the
 * single source of truth and unsigned local builds stay inert automatically.
 */
export function readWebAuthnKeychainAccessGroup(entitlementsXml: string): string | null {
  const groupsMatch = /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
    entitlementsXml
  )
  if (!groupsMatch) {
    return null
  }
  for (const match of groupsMatch[1].matchAll(/<string>([^<]*)<\/string>/g)) {
    const group = match[1].trim()
    if (group.endsWith(ORCA_WEBAUTHN_KEYCHAIN_GROUP_SUFFIX)) {
      return group
    }
  }
  return null
}

function readSignedEntitlements(execPath: string): string {
  // Why: `codesign -d --entitlements :-` prints the signed entitlement plist to stdout.
  const result = runProcessSync({
    program: 'codesign',
    args: ['-d', '--entitlements', ':-', execPath],
    timeoutMs: 10_000
  })
  if (result.code !== 0) {
    throw new Error(`codesign exited ${result.code ?? result.signal}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

export function enablePlatformPasskeys(
  app: PlatformPasskeyApp,
  options: {
    platform?: NodeJS.Platform
    execPath?: string
    readEntitlements?: (execPath: string) => string
  } = {}
): PlatformPasskeyOutcome {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { status: 'skipped', reason: 'not-macos' }
  }
  if (!app.isPackaged) {
    return { status: 'skipped', reason: 'unpackaged' }
  }
  if (typeof app.configureWebAuthn !== 'function') {
    return { status: 'skipped', reason: 'api-unavailable' }
  }
  let keychainAccessGroup: string | null
  try {
    keychainAccessGroup = readWebAuthnKeychainAccessGroup(
      (options.readEntitlements ?? readSignedEntitlements)(options.execPath ?? process.execPath)
    )
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  if (!keychainAccessGroup) {
    return { status: 'skipped', reason: 'no-entitlement' }
  }
  try {
    // Why the explicit reason: Electron's default reads from a locale pak that can be
    // missing, and an empty reason crashes the LAContext prompt (electron#53185).
    app.configureWebAuthn({
      touchID: { keychainAccessGroup, promptReason: 'sign in to $1' }
    })
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  return { status: 'enabled', keychainAccessGroup }
}
