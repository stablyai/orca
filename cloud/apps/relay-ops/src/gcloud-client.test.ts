import { describe, expect, it } from 'vitest'
import { createGcloudClient } from './gcloud-client.js'

describe('createGcloudClient', () => {
  it('shares and caches one credential refresh across concurrent readers', async () => {
    let calls = 0
    const token = 'a'.repeat(40)
    const client = createGcloudClient(async () => {
      calls += 1
      await Promise.resolve()
      return token
    })

    const values = await Promise.all([
      client.accessToken(),
      client.accessToken(),
      client.accessToken()
    ])

    expect(values).toEqual([token, token, token])
    expect(await client.accessToken()).toBe(token)
    expect(calls).toBe(1)
  })

  it('caches bounded identity tokens by audience', async () => {
    const commands: string[][] = []
    const token = 'aaa.bbb.ccc'
    const client = createGcloudClient(async (args) => {
      commands.push(args)
      return token
    })
    await expect(client.identityToken?.('https://relay.example/admin')).resolves.toBe(token)
    await expect(client.identityToken?.('https://relay.example/admin')).resolves.toBe(token)
    expect(commands).toEqual([
      [
        'auth',
        'print-identity-token',
        '--audiences=https://relay.example/admin',
        '--include-email'
      ]
    ])
  })
})
