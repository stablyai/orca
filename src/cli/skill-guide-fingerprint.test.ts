import { afterEach, describe, expect, it, vi } from 'vitest'
import { skillGuideCliVersion, skillGuideContentSha256 } from './skill-guide-fingerprint'

describe('skillGuideContentSha256', () => {
  it('returns a stable 64-hex digest', () => {
    expect(skillGuideContentSha256('hello')).toMatch(/^[a-f0-9]{64}$/)
    expect(skillGuideContentSha256('hello')).toBe(skillGuideContentSha256('hello'))
    expect(skillGuideContentSha256('hello')).not.toBe(skillGuideContentSha256('world'))
  })
})

describe('skillGuideCliVersion', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers ORCA_APP_VERSION', () => {
    vi.stubEnv('ORCA_APP_VERSION', '9.9.9-env')
    vi.stubEnv('npm_package_version', '0.0.1')
    expect(skillGuideCliVersion()).toBe('9.9.9-env')
  })

  it('falls back to npm_package_version when ORCA_APP_VERSION is blank', () => {
    vi.stubEnv('ORCA_APP_VERSION', '   ')
    vi.stubEnv('npm_package_version', '2.3.4-npm')
    expect(skillGuideCliVersion()).toBe('2.3.4-npm')
  })

  it('reads a nearby package.json version when env is unset', () => {
    vi.stubEnv('ORCA_APP_VERSION', '')
    vi.stubEnv('npm_package_version', '')
    delete process.env.ORCA_APP_VERSION
    delete process.env.npm_package_version
    // Repo root package.json is named orca and walks from this test file.
    expect(skillGuideCliVersion()).toMatch(/^\d+\.\d+/)
    expect(skillGuideCliVersion()).not.toBe('unknown')
  })
})
