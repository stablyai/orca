import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertMacPasskeySigningDisabled } = require('./mac-webauthn-signing.cjs')
const tempDirs = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function options(xml) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'orca-mac-signing-'))
  tempDirs.push(repoRoot)
  await writeFile(join(repoRoot, 'entitlements.plist'), xml)
  return { repoRoot, entitlementsPaths: ['entitlements.plist'], env: {} }
}

describe('assertMacPasskeySigningDisabled', () => {
  it('allows the ordinary unrestricted entitlements', async () => {
    const input = await options(
      '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>'
    )
    expect(() => assertMacPasskeySigningDisabled(input)).not.toThrow()
  })

  it.each([
    'keychain-access-groups',
    'com.apple.application-identifier',
    'com.apple.developer.team-identifier'
  ])('rejects %s before signing regardless of its value', async (key) => {
    const input = await options(`<plist><dict><key>${key}</key><array/></dict></plist>`)
    expect(() => assertMacPasskeySigningDisabled(input)).toThrow(/must not ship/)
  })

  it('checks every entitlement input, including helper entitlements', async () => {
    const input = await options('<plist><dict/></plist>')
    await writeFile(join(input.repoRoot, 'helper.plist'), '<key>keychain-access-groups</key>')
    input.entitlementsPaths.push('helper.plist')
    expect(() => assertMacPasskeySigningDisabled(input)).toThrow(/helper.plist/)
  })

  it.each(['missing.provisionprofile', 'expired.provisionprofile', 'valid.provisionprofile'])(
    'rejects retired profile opt-in %s instead of silently enabling or falling back',
    async (profile) => {
      const input = await options('<plist><dict/></plist>')
      input.env = { ORCA_MAC_PROVISIONING_PROFILE: profile, APPLE_TEAM_ID: 'ABCDE12345' }
      expect(() => assertMacPasskeySigningDisabled(input)).toThrow(/unsupported/)
    }
  )

  it('fails closed on unreadable entitlements', async () => {
    const input = await options('<plist><dict/></plist>')
    input.entitlementsPaths.push('missing.plist')
    expect(() => assertMacPasskeySigningDisabled(input)).toThrow()
  })
})
