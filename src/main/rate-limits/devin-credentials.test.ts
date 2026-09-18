import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDevinCredentialsPath, readDevinCredentials } from './devin-credentials'

const originalDevinHome = process.env.DEVIN_HOME
let tempDirs: string[] = []

afterEach(async () => {
  process.env.DEVIN_HOME = originalDevinHome
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function makeDevinRoot(toml: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-devin-creds-'))
  tempDirs.push(root)
  process.env.DEVIN_HOME = root
  if (toml !== null) {
    await writeFile(join(root, 'credentials.toml'), toml)
  }
  return root
}

describe('readDevinCredentials', () => {
  it('resolves credentials.toml at the devin root', async () => {
    const root = await makeDevinRoot(null)
    expect(getDevinCredentialsPath()).toBe(join(root, 'credentials.toml'))
  })

  it('reports missing when no credentials file exists', async () => {
    await makeDevinRoot(null)
    expect(readDevinCredentials()).toEqual({ status: 'missing' })
  })

  it('reports missing for a token-less file — signed out, not corrupt', async () => {
    await makeDevinRoot('other_key = "value"\n')
    expect(readDevinCredentials()).toEqual({ status: 'missing' })
  })

  it('normalizes the session token prefix and defaults the API server', async () => {
    await makeDevinRoot('windsurf_api_key = "raw-token"\n')
    expect(readDevinCredentials()).toEqual({
      status: 'ok',
      credentials: {
        sessionToken: 'devin-session-token$raw-token',
        apiServerUrl: 'https://server.codeium.com'
      }
    })
  })

  it('honours a custom https api_server_url', async () => {
    await makeDevinRoot(
      'windsurf_api_key = "devin-session-token$tok"\napi_server_url = "https://staging.example.com"\n'
    )
    expect(readDevinCredentials()).toEqual({
      status: 'ok',
      credentials: {
        sessionToken: 'devin-session-token$tok',
        apiServerUrl: 'https://staging.example.com'
      }
    })
  })

  it('rejects an http api_server_url — the token must never travel cleartext', async () => {
    await makeDevinRoot('windsurf_api_key = "tok"\napi_server_url = "http://server.codeium.com"\n')
    const result = readDevinCredentials()
    expect(result.status).toBe('error')
    expect(result).not.toEqual({ status: 'ok' })
  })

  it('rejects a non-URL api_server_url', async () => {
    await makeDevinRoot('windsurf_api_key = "tok"\napi_server_url = "not a url"\n')
    expect(readDevinCredentials().status).toBe('error')
  })

  it('reports a malformed credentials line as an error, not as signed out', async () => {
    await makeDevinRoot('windsurf_api_key = unquoted\n')
    expect(readDevinCredentials().status).toBe('error')
  })
})
