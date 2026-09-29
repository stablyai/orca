import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearMirroredCodexCredentials } from './codex-credential-mirror-consent-revocation'

// G2: revocation deleted auth.json and the system-default-auth.json snapshot but left the full
// credential sitting in shared-runtime-auth-provenance.json (authJson / runtimeAuthJson), so a
// revoked user still had a stored credential copy on disk. Revocation must remove every copy.
describe('clearMirroredCodexCredentials provenance scrub (G2)', () => {
  let userDataDir: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-revocation-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('removes the credential copy stored in shared-runtime-auth-provenance.json', () => {
    const provenancePath = join(
      userDataDir,
      'codex-runtime-home',
      'shared-runtime-auth-provenance.json'
    )
    writeFileSync(
      provenancePath,
      `${JSON.stringify({ owner: 'system-default', authJson: '{"tokens":{"refresh_token":"secret"}}' })}\n`,
      'utf-8'
    )

    clearMirroredCodexCredentials()

    expect(existsSync(provenancePath)).toBe(false)
  })

  // G3: the no-consent branch of restoreSystemDefaultSnapshot can still stamp
  // system-default-runtime-logout.json (via persistRuntimeLogoutMarker's default read of
  // ~/.codex/auth.json in other, consented call paths); revocation must remove that copy too.
  it('removes the logout marker copy', () => {
    const markerPath = join(userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
    writeFileSync(
      markerPath,
      `${JSON.stringify({ systemDefaultAuthJson: '{"tokens":{"refresh_token":"secret"}}', loggedOutAt: 1 })}\n`,
      'utf-8'
    )

    clearMirroredCodexCredentials()

    expect(existsSync(markerPath)).toBe(false)
  })

  // G3: markSharedRuntimeAuthManaged writes owner: 'managed' provenance for a retained managed
  // pane that may hold its own refreshed credential in the shared auth.json. Wiping the file
  // wholesale erased that ownership record even though revoking mirror consent never touched a
  // managed account's own credential -- only the system-default copy the mirror made.
  it('leaves managed-owner provenance and its credential file untouched', () => {
    const provenancePath = join(
      userDataDir,
      'codex-runtime-home',
      'shared-runtime-auth-provenance.json'
    )
    const managedAuthPath = join(userDataDir, 'codex-runtime-home', 'home', 'auth.json')
    const managedProvenance = { owner: 'managed', accountId: 'acct-1' }
    writeFileSync(provenancePath, `${JSON.stringify(managedProvenance)}\n`, 'utf-8')
    writeFileSync(managedAuthPath, '{"tokens":{"refresh_token":"managed-secret"}}\n', 'utf-8')

    clearMirroredCodexCredentials()

    expect(existsSync(provenancePath)).toBe(true)
    expect(JSON.parse(readFileSync(provenancePath, 'utf-8'))).toEqual(managedProvenance)
    expect(existsSync(managedAuthPath)).toBe(true)
  })
})
