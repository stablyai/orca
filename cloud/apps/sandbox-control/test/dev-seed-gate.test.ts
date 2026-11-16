// The dev GitHub seed route stores any installation token as a member's GitHub user token: it must not exist
// outside dev/local/test, whatever else is configured.
import { describe, expect, it } from 'vitest'
import { devOnly } from '../src/dev-only'
import { createHarness } from './harness'

const OP = 'o'.repeat(40)

describe('dev member-github seed route gate', () => {
  it('is an allowlist: only dev, local and test', () => {
    for (const env of ['dev', 'local', 'test']) {
      expect(devOnly({ SANDBOX_ENV: env })).toBe(true)
    }
    for (const env of ['prod', 'staging', '', 'Dev', 'production', 'dev ', undefined as unknown as string]) {
      expect(devOnly({ SANDBOX_ENV: env })).toBe(false)
    }
  })

  it('answers 404 in staging and prod even with the operator token, and stores nothing', async () => {
    for (const SANDBOX_ENV of ['staging', 'prod']) {
      const h = await createHarness({ SANDBOX_ENV, OPERATOR_TOKEN: OP, SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
      const seeded = await h.call('POST', '/v1/internal/dev/member-github', {
        bearer: OP,
        body: { accountId: 'org:acme', userId: 'alice', repoUrl: 'https://github.com/acme/app', login: 'alice-gh', githubUserId: 11, name: 'A' }
      })
      expect(seeded.status).toBe(404)
      expect(h.raw.prepare('SELECT COUNT(*) AS n FROM github_user_tokens').get()).toEqual({ n: 0 })
    }
  })

  it('the other dev-only routes are gone in staging too (seed, dev connect, codex login, manifest)', async () => {
    const h = await createHarness({ SANDBOX_ENV: 'staging', OPERATOR_TOKEN: OP })
    for (const [method, path] of [
      ['POST', '/v1/internal/dev/codex-login'],
      ['GET', '/v1/github/dev-connect'],
      ['GET', '/v1/github/dev-user-connect'],
      ['GET', '/v1/github/manifest-start']
    ] as const) {
      expect((await h.call(method, path, { bearer: OP, body: method === 'POST' ? {} : undefined })).status, path).toBe(404)
    }
  })
})

