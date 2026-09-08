import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { redactSessionSearchText } from './session-search-redaction'
import { SessionSearchStore } from './session-search-store'
import {
  CLAUDE_SESSION_ID as SESSION_ID,
  parseTranscript,
  userRecord
} from './session-search-transcript-fixtures'

const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAqhVmVvXTPQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '-----END RSA PRIVATE KEY-----'
].join('\n')

let tempRoots: string[] = []
let store: SessionSearchStore

beforeEach(async () => {
  resetSessionParseCacheForTests()
  const root = await makeTempDir()
  store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  registerSessionSearchIndexSink(store)
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-redaction-'))
  tempRoots.push(root)
  return root
}

describe('session search redaction', () => {
  it('keeps the fingerprint patterns and leaves ordinary transcript shapes alone', () => {
    expect(redactSessionSearchText(`key ${AWS_KEY} here`)).toBe(
      'key [redacted:aws-access-key-id] here'
    )
    expect(redactSessionSearchText(`Authorization: Bearer ${JWT}`)).toBe(
      'Authorization: Bearer [redacted:jwt]'
    )
    // Opaque (non-JWT) bearer values are covered too; the label survives.
    expect(redactSessionSearchText('Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(
      'Bearer [redacted:bearer-token]'
    )
    // Why these and not `redactString`: env-shaped code lines and `token:` prose
    // are ordinary transcript content and must stay searchable.
    for (const benign of [
      'MAX_RETRIES = 3',
      'the auth token: refreshed on 401',
      'API_KEY_HEADER'
    ]) {
      expect(redactSessionSearchText(benign)).toBe(benign)
    }
  })

  it('never indexes a credential that appeared in tool output', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      path,
      `${[
        userRecord(0, 'deploy the staging worker'),
        userRecord(1, [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              'writing deployment credentials to the staging environment',
              `github_token=${GITHUB_TOKEN}`,
              `aws_access_key_id=${AWS_KEY}`,
              `authorization: Bearer ${JWT}`,
              PEM,
              'deployment finished with a green rollout'
            ].join('\n')
          }
        ])
      ].join('\n')}\n`
    )
    await parseTranscript(path)

    // The surrounding words stay searchable...
    const hit = store.search({ query: 'deployment credentials staging' })
    expect(hit.hits).toHaveLength(1)
    expect(store.search({ query: 'green rollout' }).hits).toHaveLength(1)
    // ...and the redaction marker rides along in the snippet.
    expect(store.search({ query: 'redacted' }).hits[0]?.evidence.snippet).toContain('redacted')

    // ...but none of the secrets are findable.
    for (const secret of [
      GITHUB_TOKEN,
      AWS_KEY,
      JWT,
      'MIIEowIBAAKCAQEAqhVmVvXTPQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    ]) {
      expect(store.search({ query: secret }).hits).toHaveLength(0)
    }
  })
})
