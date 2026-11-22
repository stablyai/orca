import { app } from 'electron'

// Must match the keychain-access-groups entitlement electron-builder.config.cjs signs release builds with.
const ORCA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP = '6CX3WHS9HZ.com.stablyai.orca.webauthn'

/**
 * Lets pages create and use passkeys stored in this Mac's Secure Enclave behind Touch ID.
 * Builds signed without the entitlement keep reporting no platform authenticator.
 */
export function enableBrowserTouchIdPasskeys(): void {
  if (process.platform !== 'darwin') {
    return
  }
  // Why guarded: browser startup must not fail because a passkey authenticator could not be set up.
  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: ORCA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
        promptReason: 'sign in to $1'
      }
    })
  } catch (error) {
    console.warn('[browser-webauthn] Touch ID passkeys unavailable:', error)
  }
}
