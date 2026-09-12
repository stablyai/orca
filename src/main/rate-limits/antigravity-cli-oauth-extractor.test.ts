import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetAntigravityOAuthClientCache,
  scanAgyBinaryForOAuthClients
} from './antigravity-cli-oauth-extractor'

describe('scanAgyBinaryForOAuthClients', () => {
  let dir: string

  afterEach(() => {
    resetAntigravityOAuthClientCache()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts Google OAuth client ids and secrets from a binary blob', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orca-agy-bin-'))
    mkdirSync(dir, { recursive: true })
    const binaryPath = path.join(dir, 'agy')
    const clientId = '1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com'
    const clientSecret = 'GOCSPX-TestSecret_abc-123'
    writeFileSync(binaryPath, `noise${clientId}\0more${clientSecret}\0tail`)

    await expect(scanAgyBinaryForOAuthClients(binaryPath)).resolves.toEqual([
      { clientId, clientSecret }
    ])
  })

  it('splits concatenated GOCSPX secrets and tries every id/secret pair', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orca-agy-bin-'))
    mkdirSync(dir, { recursive: true })
    const binaryPath = path.join(dir, 'agy')
    const clientIdA = '1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com'
    const clientIdB = '9876543210-zyxwvutsrqponmlkjihgfedcba.apps.googleusercontent.com'
    const secretA = 'GOCSPX-TestSecret_aaa-111'
    const secretB = 'GOCSPX-TestSecret_bbb-222'
    writeFileSync(
      binaryPath,
      `noise${clientIdA}\0${clientIdB}\0${secretA}${secretB}https://cloudcode.example\0tail`
    )

    await expect(scanAgyBinaryForOAuthClients(binaryPath)).resolves.toEqual([
      { clientId: clientIdA, clientSecret: secretA },
      { clientId: clientIdA, clientSecret: secretB },
      { clientId: clientIdB, clientSecret: secretA },
      { clientId: clientIdB, clientSecret: secretB }
    ])
  })
})
