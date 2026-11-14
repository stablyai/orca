import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodexRateLimitsViaBackend,
  supplementCodexUsageWindows
} from './codex-backend-usage-client'

const spendCapPayload = {
  plan_type: 'business',
  rate_limit: null,
  spend_control: {
    reached: false,
    individual_limit: { remaining_percent: 75, reset_at: 1_785_542_400 }
  }
}

describe('Codex backend spend_control', () => {
  let codexHomePath: string

  beforeEach(() => {
    codexHomePath = mkdtempSync(join(tmpdir(), 'codex-backend-usage-'))
    writeFileSync(
      join(codexHomePath, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 't' } })
    )
  })

  afterEach(() => {
    rmSync(codexHomePath, { recursive: true, force: true })
  })

  it('shows the individual spend cap as the monthly window when no 5h/7d window is reported', async () => {
    const limits = await fetchCodexRateLimitsViaBackend(
      async () => new Response(JSON.stringify(spendCapPayload)),
      { codexHomePath }
    )

    expect(limits?.session).toBeNull()
    expect(limits?.weekly).toBeNull()
    expect(limits?.monthly).toMatchObject({
      usedPercent: 25,
      windowMinutes: 43_200,
      resetsAt: 1_785_542_400_000
    })
  })

  it('reads the spend cap from the backend when the app-server reports no usage window', async () => {
    const limits = await supplementCodexUsageWindows(
      { provider: 'codex', session: null, weekly: null, updatedAt: 1, error: null, status: 'ok' },
      async () => new Response(JSON.stringify(spendCapPayload)),
      { codexHomePath }
    )

    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
    expect(limits.monthly).toMatchObject({ usedPercent: 25, windowMinutes: 43_200 })
  })
})
