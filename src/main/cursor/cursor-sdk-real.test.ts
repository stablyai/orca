import { describe, expect, it } from 'vitest'

const enabled = process.env.ORCA_REAL_CURSOR_SDK_TEST === '1' && Boolean(process.env.CURSOR_API_KEY)

describe.skipIf(!enabled)('Cursor SDK on this machine', () => {
  it('lists models with the opted-in key', async () => {
    const sdk = await import('@cursor/sdk')
    const models = await sdk.Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY })
    expect(models.length).toBeGreaterThan(0)
  })
})
