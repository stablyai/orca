import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { readCodexSessionResumeProvider } from './codex-session-resume-provider'

const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
let homePath: string
let transcriptPath: string

beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), 'orca-resume-provider-'))
  const sessions = join(homePath, 'sessions', '2026', '11', '06')
  await mkdir(sessions, { recursive: true })
  transcriptPath = join(sessions, `rollout-${sessionId}.jsonl`)
})

afterEach(async () => {
  await rm(homePath, { recursive: true, force: true })
})

async function rollout(provider: string | undefined, id = sessionId): Promise<void> {
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n`
  )
}

function index(provider: string): void {
  const db = new SyncDatabase(join(homePath, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(sessionId, provider)
  } finally {
    db.close()
  }
}

function read(): Promise<string | null> {
  return readCodexSessionResumeProvider({ sessionId, homePath, transcriptPath })
}

describe('saved Codex resume model provider', () => {
  it.each(['openai', 'headroom'])(
    'preserves the durable %s identity across restart',
    async (provider) => {
      await rollout(provider)
      index(provider)
      await expect(read()).resolves.toBe(provider)
      await expect(read()).resolves.toBe(provider)
    }
  )

  it('uses the rollout when no index exists, without changing its metadata', async () => {
    await rollout('openai')
    await expect(read()).resolves.toBe('openai')
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(
      '{"type":"session_meta","payload":{"id":"019f81b9-19a9-7651-a8d1-352d9420bd11","model_provider":"openai"}}\n'
    )
  })

  it('uses the indexed provider for older rollout metadata without a provider', async () => {
    await rollout(undefined)
    index('headroom')
    await expect(read()).resolves.toBe('headroom')
  })

  it('verifies a compressed historical rollout without rewriting it', async () => {
    await rollout('headroom')
    const compressed = `${transcriptPath}.zst`
    await writeFile(compressed, zstdCompressSync(await readFile(transcriptPath)))
    await rm(transcriptPath)
    transcriptPath = compressed
    index('headroom')
    await expect(read()).resolves.toBe('headroom')
  })

  it('refuses disagreement between SQLite and JSONL', async () => {
    await rollout('openai')
    index('headroom')
    await expect(read()).rejects.toThrow('providers disagree')
  })

  it('does not bypass the index comparison with an uppercase UUID', async () => {
    await rollout('openai')
    index('headroom')
    await expect(
      readCodexSessionResumeProvider({
        sessionId: sessionId.toUpperCase(),
        homePath,
        transcriptPath
      })
    ).rejects.toThrow('providers disagree')
  })

  it('leaves provider selection to Codex for unbound legacy history', async () => {
    await rollout(undefined)
    await expect(read()).resolves.toBeNull()
  })

  it('accepts a provider changed by persisted thread settings', async () => {
    await rollout('openai')
    await appendFile(
      transcriptPath,
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"headroom"}}}\n'
    )
    index('headroom')
    await expect(read()).resolves.toBe('headroom')
  })

  it('uses the latest persisted provider even before an index exists', async () => {
    await rollout('openai')
    await appendFile(
      transcriptPath,
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"copied-owner","thread_settings":{"model_provider_id":"another-provider"}}}\n{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"headroom"}}}\n'
    )
    await expect(read()).resolves.toBe('headroom')
  })

  it('applies a copied settings snapshot consistently with the Codex index extractor', async () => {
    await rollout('openai')
    await appendFile(
      transcriptPath,
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"copied-owner","thread_settings":{"model_provider_id":"headroom"}}}\n'
    )
    index('headroom')
    await expect(read()).resolves.toBe('headroom')
  })

  it('applies later metadata only for the canonical session', async () => {
    await rollout('openai')
    await appendFile(
      transcriptPath,
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"headroom"}}}\n{"type":"session_meta","payload":{"id":"019f81b9-19a9-7651-a8d1-352d9420bd11","model_provider":"openai"}}\n{"type":"session_meta","payload":{"id":"foreign-session","model_provider":"headroom"}}\n'
    )
    index('openai')
    await expect(read()).resolves.toBe('openai')
  })

  it('refuses an actual index mismatch after a saved provider change', async () => {
    await rollout('openai')
    await appendFile(
      transcriptPath,
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"headroom"}}}\n'
    )
    index('openai')
    await expect(read()).rejects.toThrow('providers disagree')
  })

  it('refuses a rollout without session metadata', async () => {
    await writeFile(transcriptPath, '{"type":"response_item","payload":{}}\n')
    await expect(read()).rejects.toThrow('saved session identity could not be verified')
  })

  it('does not expose malformed history content in the refusal', async () => {
    await writeFile(transcriptPath, '{"type":"session_meta","private":"synthetic-private-marker"')
    await expect(read()).rejects.toThrow(
      'Codex resume stopped: the saved rollout could not be decoded'
    )
  })

  it('refuses a different session under the expected filename', async () => {
    await rollout('openai', 'another-session')
    await expect(read()).rejects.toThrow('saved session identity could not be verified')
  })

  it('refuses unreadable state rather than assuming rollout authority', async () => {
    await rollout('openai')
    await writeFile(join(homePath, 'state_5.sqlite'), 'not a database')
    await expect(read()).rejects.toThrow()
  })

  it.each(['openai;echo unsafe', 'a b'])(
    'refuses an unsafe provider identifier %j',
    async (provider) => {
      await rollout(provider)
      await expect(read()).rejects.toThrow('saved model provider could not be verified')
    }
  )
})
