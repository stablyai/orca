const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

/**
 * Writes the main app's entitlements: the shared base plus the keychain group Touch ID passkeys
 * live in. Only the main app gets the group, since the provisioning profile authorizes only it.
 */
function writeMacWebAuthnEntitlements({ basePath, outPath, keychainAccessGroup }) {
  const base = readFileSync(basePath, 'utf8')
  const closingDict = base.lastIndexOf('</dict>')
  if (closingDict === -1 || base.includes('<key>keychain-access-groups</key>')) {
    throw new Error(`Cannot add keychain-access-groups to ${basePath}`)
  }
  const entry = `\t<key>keychain-access-groups</key>\n\t<array>\n\t\t<string>${keychainAccessGroup}</string>\n\t</array>\n`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, base.slice(0, closingDict) + entry + base.slice(closingDict))
  return outPath
}

module.exports = { writeMacWebAuthnEntitlements }
