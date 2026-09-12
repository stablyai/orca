const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const RESTRICTED_PASSKEY_KEYS = [
  'keychain-access-groups',
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier'
]

function assertMacPasskeySigningDisabled({ repoRoot, entitlementsPaths, env = process.env }) {
  if (env.ORCA_MAC_PROVISIONING_PROFILE) {
    throw new Error(
      'ORCA_MAC_PROVISIONING_PROFILE is unsupported: provisioning profiles can prevent Orca from launching'
    )
  }
  for (const path of entitlementsPaths) {
    const xml = readFileSync(resolve(repoRoot, path), 'utf8')
    for (const key of RESTRICTED_PASSKEY_KEYS) {
      if (xml.includes(key)) {
        throw new Error(`${path}: restricted passkey entitlement ${key} must not ship`)
      }
    }
  }
}

module.exports = { assertMacPasskeySigningDisabled }
