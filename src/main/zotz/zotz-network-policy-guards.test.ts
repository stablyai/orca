import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _setZotzCloudFeaturesOpenForTests } from '../../shared/zotz/zotz-network-policy'
import { isConsentEnvOverridden } from '../telemetry/consent'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'

const TELEMETRY_ENV_KEYS = [
  'DO_NOT_TRACK',
  'ORCA_TELEMETRY_DISABLED',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
]

describe('Zotz network policy guards', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    _setZotzCloudFeaturesOpenForTests(false)
    savedEnv = Object.fromEntries(TELEMETRY_ENV_KEYS.map((key) => [key, process.env[key]]))
    for (const key of TELEMETRY_ENV_KEYS) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    _setZotzCloudFeaturesOpenForTests(true)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('overrides telemetry consent without any opt-out environment variable', () => {
    expect(isConsentEnvOverridden()).toBe(true)
  })

  it('reports Orca Cloud sign-in as unconfigured in packaged builds', () => {
    expect(getOrcaCloudAuthConfig({}, true).configured).toBe(false)
  })
})
