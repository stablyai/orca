import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import {
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from '../orca-profiles/profile-cloud-index'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getHostedSandboxConfig } from './hosted-sandbox-config'

const state = { dir: '' }
installFakeAppEnvironment({ getPath: () => state.dir })

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
}

function cloud(userId: string, activeOrgId?: string): OrcaProfileCloudSummary {
  return {
    cloudProfileId: `cp-${userId}`,
    userId,
    email: `${userId}@example.test`,
    ...(activeOrgId ? { activeOrgId } : {}),
    linkedAt: 1
  }
}

function devConfig() {
  const keyFile = join(state.dir, 'dev-jwk.json')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  writeFileSync(
    keyFile,
    JSON.stringify({ private: { ...privateKey.export({ format: 'jwk' }), kid: 'dev2' } })
  )
  const config = getHostedSandboxConfig(
    state.dir,
    {
      ORCA_CLOUD_SANDBOX_URL: 'https://sandbox.cloud.test',
      ORCA_CLOUD_SANDBOX_DEV_KEY_FILE: keyFile
    },
    false
  )
  if (!config) {
    throw new Error('expected a hosted sandbox config')
  }
  return config
}

describe('getHostedSandboxConfig sandbox tokens', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'orca-hosted-config-test-'))
    installFakeAppEnvironment({ getPath: () => state.dir })
  })

  afterEach(() => {
    removeTreeSync(state.dir)
  })

  it('refuses to mint while signed out instead of signing as a fallback dev user', async () => {
    const config = devConfig()
    const error = await config.getAccessToken().catch((caught: unknown) => caught)
    expect(isEnvironmentProviderError(error, 'unauthorized')).toBe(true)
  })

  it('mints for the newly signed-in user after a signed-out attempt', async () => {
    const config = devConfig()
    await config.getAccessToken().catch(() => undefined)
    const profileId = ensureActiveOrcaProfile(state.dir).profile.id
    linkOrcaProfileToCloud(profileId, cloud('user-a'), state.dir)
    expect(claims(await config.getAccessToken()).sub).toBe('user-a')
  })

  it('drops the cached token on sign-out, account switch and team switch', async () => {
    const config = devConfig()
    const profileId = ensureActiveOrcaProfile(state.dir).profile.id
    linkOrcaProfileToCloud(profileId, cloud('user-a'), state.dir)
    const first = await config.getAccessToken()
    // Same identity: the cached token is reused, not re-minted.
    expect(await config.getAccessToken()).toBe(first)

    linkOrcaProfileToCloud(profileId, cloud('user-a', 'org-1'), state.dir)
    const team = claims(await config.getAccessToken())
    expect(team).toMatchObject({ sub: 'user-a', org: 'org-1' })

    linkOrcaProfileToCloud(profileId, cloud('user-b'), state.dir)
    const switched = claims(await config.getAccessToken())
    expect(switched.sub).toBe('user-b')
    expect(switched.org).toBeUndefined()

    unlinkOrcaProfileFromCloud(profileId, state.dir)
    const error = await config.getAccessToken().catch((caught: unknown) => caught)
    expect(isEnvironmentProviderError(error, 'unauthorized')).toBe(true)
  })

  it('every config instance sees an identity change, not just the one that observed it', async () => {
    const a = devConfig()
    const b = devConfig()
    const profileId = ensureActiveOrcaProfile(state.dir).profile.id
    linkOrcaProfileToCloud(profileId, cloud('user-a'), state.dir)
    await a.getAccessToken()
    await b.getAccessToken()
    linkOrcaProfileToCloud(profileId, cloud('user-b'), state.dir)
    expect(claims(await a.getAccessToken()).sub).toBe('user-b')
    expect(claims(await b.getAccessToken()).sub).toBe('user-b')
  })
})
