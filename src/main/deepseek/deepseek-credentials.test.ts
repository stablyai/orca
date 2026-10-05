import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setSecretStore } from '../../shared/secret-store'
import { DeepSeekCredentials } from './deepseek-credentials'
import {
  deepSeekCredentialFixture,
  installDeepSeekTestSecretStore,
  SYNTHETIC_DEEPSEEK_KEY
} from './deepseek-test-fixture'

describe('DeepSeek protected credentials', () => {
  let fixture: ReturnType<typeof deepSeekCredentialFixture>
  beforeEach(() => {
    installDeepSeekTestSecretStore()
    fixture = deepSeekCredentialFixture()
  })
  afterEach(() => {
    rmSync(fixture.directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('persists only sealed bytes, reads after restart, and removes without returning the key', () => {
    const saved = fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)
    expect(saved).toEqual({
      supported: true,
      configured: true,
      ownerId: 'fixture-host',
      protection: 'sealed'
    })
    expect(JSON.stringify(saved)).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
    expect(readFileSync(fixture.path, 'utf8')).not.toContain(SYNTHETIC_DEEPSEEK_KEY)
    if (process.platform !== 'win32') {
      expect(statSync(fixture.path).mode & 0o777).toBe(0o600)
    }
    expect(new DeepSeekCredentials('fixture-host', fixture.path).read()).toBe(
      SYNTHETIC_DEEPSEEK_KEY
    )
    expect(fixture.credentials.remove('fixture-host').configured).toBe(false)
    expect(fixture.credentials.read()).toBeNull()
  })

  it('fences saves and removal by the immutable execution owner', () => {
    fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)
    const revision = fixture.credentials.revision()
    expect(() => fixture.credentials.save('other-host', 'replacement')).toThrow('owner changed')
    expect(() => fixture.credentials.remove('other-host')).toThrow('owner changed')
    expect(fixture.credentials.revision()).toBe(revision)
    expect(fixture.credentials.getStatus().ownerId).toBe('fixture-host')
  })

  it.each([false, true])(
    'refuses missing or weak sealing without overwriting the prior file (weak=%s)',
    (weak) => {
      fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)
      const original = readFileSync(fixture.path)
      const encryptString = vi.fn(() => {
        throw new Error(SYNTHETIC_DEEPSEEK_KEY)
      })
      setSecretStore({
        isEncryptionAvailable: () => weak,
        describeProtectionGap: () => 'weak',
        encryptString,
        decryptString: () => ''
      })
      expect(() => fixture.credentials.save('fixture-host', 'replacement')).toThrow(
        'protected storage is unavailable'
      )
      expect(fixture.credentials.getStatus()).toMatchObject({ supported: false, configured: true })
      expect(readFileSync(fixture.path)).toEqual(original)
      expect(encryptString).not.toHaveBeenCalled()
    }
  )

  it('sanitizes decrypt and write failures and never accepts a legacy plaintext file', () => {
    writeFileSync(fixture.path, SYNTHETIC_DEEPSEEK_KEY)
    expect(fixture.credentials.getStatus().protection).toBeNull()
    expect(() => fixture.credentials.read()).toThrow('could not be read')
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: () => {
        throw new Error(SYNTHETIC_DEEPSEEK_KEY)
      },
      decryptString: () => {
        throw new Error(SYNTHETIC_DEEPSEEK_KEY)
      }
    })
    expect(() => fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)).toThrow(
      'could not be saved'
    )
    expect(() => fixture.credentials.read()).not.toThrow(SYNTHETIC_DEEPSEEK_KEY)
  })

  it('ignores environment-only candidates and keeps the constructor path after HOME changes', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', SYNTHETIC_DEEPSEEK_KEY)
    expect(fixture.credentials.read()).toBeNull()
    fixture.credentials.save('fixture-host', SYNTHETIC_DEEPSEEK_KEY)
    vi.stubEnv('HOME', fixture.directory)
    expect(fixture.credentials.read()).toBe(SYNTHETIC_DEEPSEEK_KEY)
  })

  it('does not probe the OS keyring for background presence snapshots', () => {
    const probe = vi.fn(() => true)
    setSecretStore({
      isEncryptionAvailable: probe,
      describeProtectionGap: () => null,
      encryptString: () => Buffer.from('sealed'),
      decryptString: () => ''
    })
    expect(fixture.credentials.getStatus(false).configured).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(fixture.credentials.getStatus().supported).toBe(true)
    expect(fixture.credentials.getStatus(false).supported).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
