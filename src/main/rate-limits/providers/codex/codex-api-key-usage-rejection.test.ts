import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { classifyCodexApiKeyUsageRejection } from './codex-api-key-usage-rejection'

const rejection: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  updatedAt: 1,
  error: 'chatgpt authentication required to read rate limits',
  status: 'error'
}

describe('classifyCodexApiKeyUsageRejection', () => {
  let codexHomePath: string

  beforeEach(async () => {
    codexHomePath = await mkdtemp(join(tmpdir(), 'codex-api-key-usage-'))
  })

  afterEach(async () => {
    await rm(codexHomePath, { recursive: true, force: true })
  })

  it('marks an API-key home as usage unavailable so the status bar offers no sign-in', async () => {
    await writeFile(join(codexHomePath, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))

    const result = await classifyCodexApiKeyUsageRejection(rejection, { codexHomePath })

    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('leaves an old ChatGPT login that still holds tokens asking for a fresh sign-in', async () => {
    await writeFile(
      join(codexHomePath, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: { access_token: 'at', account_id: 'a' } })
    )

    const result = await classifyCodexApiKeyUsageRejection(rejection, { codexHomePath })

    expect(result.usageMetadata?.failureKind).toBeUndefined()
  })
})
