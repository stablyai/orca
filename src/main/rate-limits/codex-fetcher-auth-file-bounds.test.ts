import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import { MAX_INTEGRATION_CREDENTIAL_FILE_BYTES } from '../integration-credential-file'
import { consumeCodexRateLimitResetCredit } from './codex-fetcher'

const fetchMock = vi.hoisted(() => vi.fn())
const roots: string[] = []

function createCodexHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-auth-bounds-'))
  roots.push(root)
  return root
}

function successfulConsumeResponse(): Response {
  return new Response(JSON.stringify({ code: 'already_redeemed' }), {
    headers: { 'content-type': 'application/json' },
    status: 200
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(successfulConsumeResponse())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Codex backend auth file bounds', () => {
  it('preserves normal auth JSON and backend headers', async () => {
    const codexHomePath = createCodexHome()
    writeFileSync(
      join(codexHomePath, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: 'normal-token', account_id: 'normal-account' }
      })
    )

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath,
        idempotencyKey: 'normal-auth'
      })
    ).resolves.toBe('alreadyRedeemed')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer normal-token',
          'ChatGPT-Account-Id': 'normal-account'
        })
      })
    )
  })

  it('accepts valid auth JSON at the exact credential byte limit', async () => {
    const codexHomePath = createCodexHome()
    const authPath = join(codexHomePath, 'auth.json')
    const json = JSON.stringify({
      tokens: { access_token: 'boundary-token', account_id: 'boundary-account' }
    })
    writeFileSync(
      authPath,
      json + ' '.repeat(MAX_INTEGRATION_CREDENTIAL_FILE_BYTES - Buffer.byteLength(json))
    )

    expect(statSync(authPath).size).toBe(MAX_INTEGRATION_CREDENTIAL_FILE_BYTES)
    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath,
        idempotencyKey: 'boundary-auth'
      })
    ).resolves.toBe('alreadyRedeemed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects an oversized sparse auth file before making a request', async () => {
    const codexHomePath = createCodexHome()
    const authPath = join(codexHomePath, 'auth.json')
    writeFileSync(authPath, '')
    truncateSync(authPath, MAX_INTEGRATION_CREDENTIAL_FILE_BYTES + 1)

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath,
        idempotencyKey: 'oversized-auth'
      })
    ).rejects.toBeInstanceOf(NodeFileReadTooLargeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
