import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexRolloutSessionMetaId } from './codex-rollout-session-meta'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('readCodexRolloutSessionMetaId', () => {
  it('reads the session id from the first rollout record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const rollout = join(root, 'rollout.jsonl')
    await writeFile(
      rollout,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-id' } })}\nignored`
    )

    await expect(readCodexRolloutSessionMetaId(rollout)).resolves.toBe('session-id')
  })

  it('returns null for a missing or malformed rollout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const malformed = join(root, 'malformed.jsonl')
    await writeFile(malformed, '{"type":"session_meta"')

    await expect(readCodexRolloutSessionMetaId(join(root, 'missing.jsonl'))).resolves.toBeNull()
    await expect(readCodexRolloutSessionMetaId(malformed)).resolves.toBeNull()
  })
})
