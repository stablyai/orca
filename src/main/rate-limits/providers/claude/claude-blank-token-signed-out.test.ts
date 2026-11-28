// Claude Code empties accessToken+refreshToken once a refresh fails but keeps subscriptionType;
// that credentials entry is a signed-out subscription login, not an API-key user. (#48455)
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'

let configDir = ''

afterEach(async () => {
  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    configDir = ''
  }
})

async function credentialsDir(claudeAiOauth: Record<string, unknown>): Promise<string> {
  configDir = await mkdtemp(join(tmpdir(), 'orca-claude-creds-'))
  await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth }))
  return configDir
}

function systemAuth(configDir: string) {
  return {
    configDir,
    envPatch: {},
    provenance: 'system'
  }
}

describe('fetchActiveClaudeRateLimits on a blanked subscription login', () => {
  it('reports a signed-out account, not API-key billing, when tokens are blank but a plan remains', async () => {
    const dir = await credentialsDir({
      accessToken: '',
      refreshToken: '',
      subscriptionType: 'pro',
      scopes: ['user:profile', 'user:inference']
    })

    const result = await fetchActiveClaudeRateLimits({ authPreparation: systemAuth(dir) })

    expect(result.status).toBe('error')
    expect(result.error).not.toContain('API key billing')
    expect(result.error).toContain('Sign in')
  })

  it('still reports API-key billing for a credentials entry with no subscription plan', async () => {
    const dir = await credentialsDir({ accessToken: '', refreshToken: '' })

    const result = await fetchActiveClaudeRateLimits({ authPreparation: systemAuth(dir) })

    expect(result.error).toContain('API key billing')
  })
})
