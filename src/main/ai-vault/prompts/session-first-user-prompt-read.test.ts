import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAiVaultFirstUserPrompt } from './session-first-user-prompt-read'

const tempRoots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readAiVaultFirstUserPrompt', () => {
  it('returns the full first user prompt without preview truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-first-prompt-'))
    tempRoots.push(root)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const longPrompt = `Please implement the full vault first-prompt copy path.\n\n${'detail '.repeat(80).trimEnd()}`
    const filePath = join(projectDir, 'session.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'full-prompt-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/repo/app',
          isMeta: false,
          message: { role: 'user', content: longPrompt }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'full-prompt-session',
          timestamp: '2026-05-01T10:01:00.000Z',
          message: { role: 'assistant', content: 'Working on it.', model: 'claude-sonnet-4-5' }
        })
      ].join('\n')
    )

    const result = await readAiVaultFirstUserPrompt({
      agent: 'claude',
      filePath
    })

    expect(result.prompt).toBe(longPrompt)
    expect(result.prompt?.includes('\n\n')).toBe(true)
    expect(result.prompt?.length).toBeGreaterThan(220)
  })

  it('extracts full Codex input_text content blocks (not preview-capped)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-first-prompt-codex-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-full.jsonl')
    await mkdir(join(root, 'sessions', '2026', '07', '21'), { recursive: true })
    const longPrompt = `Review the PR and fix real regressions.\n\n${'context '.repeat(60).trimEnd()}`
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-full-prompt', cwd: '/repo/app' }
        }),
        JSON.stringify({
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: longPrompt }]
          }
        })
      ].join('\n')
    )

    const result = await readAiVaultFirstUserPrompt({
      agent: 'codex',
      filePath: sessionPath,
      codexHome: root
    })

    expect(result.prompt).toBe(longPrompt)
    expect(result.prompt?.length).toBeGreaterThan(220)
  })
})
