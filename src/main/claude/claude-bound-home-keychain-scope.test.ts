// The unscoped `Claude Code-credentials` Keychain item belongs to the shared home. Letting it
// answer for a bound directory would declare a never-signed-in group home usable and launch the
// user's personal account under the group's name — the wrong-identity failure the binding prevents.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type * as ClaudeKeychain from '../claude-accounts/keychain'

const LEGACY_SHARED_CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: 'personal-token', refreshToken: 'personal-refresh' }
})

/** Nothing scoped to the bound directory; the shared login only, exactly as an unscoped read. */
const readActiveClaudeKeychainCredentialsStrict = vi.fn(async (configDir?: string) =>
  configDir === undefined ? LEGACY_SHARED_CREDENTIALS : null
)
const readActiveClaudeKeychainCredentials = vi.fn(async () => LEGACY_SHARED_CREDENTIALS)

vi.mock('../claude-accounts/keychain', async (importActual) => ({
  ...(await importActual<typeof ClaudeKeychain>()),
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
}))

const { ClaudeBoundHomeRefusalError, assertClaudeBoundHomeUsable } =
  await import('./claude-bound-home-refusal')

const ROOT = mkdtempSync(join(tmpdir(), 'orca-bound-home-keychain-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('bound home credential scope', () => {
  it('reads signed out when only the unscoped legacy Keychain item exists', async () => {
    await expect(
      assertClaudeBoundHomeUsable({
        binding: { configDir: ROOT, groupId: 'group-1' },
        location: { executionHostId: 'local', wslDistro: null },
        launchEnv: {},
        probe: { platform: 'darwin' }
      })
    ).rejects.toThrow(ClaudeBoundHomeRefusalError)

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(ROOT)
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalledWith(undefined)
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
  })
})
