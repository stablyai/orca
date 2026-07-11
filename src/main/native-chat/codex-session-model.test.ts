import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCodexSessionModel } from './codex-session-model'

describe('readCodexSessionModel', () => {
  it('returns the latest model and effort from turn_context records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-codex-session-model-'))
    const filePath = join(directory, 'rollout.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'xhigh' } })
      ].join('\n')
    )

    await expect(readCodexSessionModel(filePath)).resolves.toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh'
    })
  })

  it('ignores malformed and unrelated records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-codex-session-model-empty-'))
    const filePath = join(directory, 'rollout.jsonl')
    await writeFile(filePath, '{bad json}\n{"type":"session_meta","payload":{}}\n')

    await expect(readCodexSessionModel(filePath)).resolves.toBeUndefined()
  })
})
