import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevinSessionFile } from './session-scanner-devin-parser'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('parseDevinSessionFile', () => {
  it('parses minimal ATIF transcript fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'abc.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'abc',
        agent: { model_name: 'swe-1-6-fast' },
        steps: [
          {
            metadata: {
              created_at: '2026-01-01T00:00:00Z',
              is_user_input: true,
              metrics: { input_tokens: 1, output_tokens: 2 }
            },
            text: 'Hello Devin'
          }
        ]
      })
    )

    const session = await parseDevinSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session).not.toBeNull()
    expect(session?.sessionId).toBe('abc')
    expect(session?.model).toBe('swe-1-6-fast')
    expect(session?.totalTokens).toBe(3)
    expect(session?.messageCount).toBe(1)
    expect(session?.title).toBe('Hello Devin')
  })

  it('parses current ATIF token and model fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'current.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'current',
        agent: {},
        steps: [
          {
            role: 'assistant',
            metadata: {
              created_at: '2026-05-26T00:00:00Z',
              generation_model: 'swe-1-6',
              total_input_tokens: 10,
              output_tokens: 4,
              cache_read_tokens: 3,
              cache_creation_tokens: 2
            },
            message: {
              content: 'Done'
            }
          }
        ]
      })
    )

    const session = await parseDevinSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session?.model).toBe('swe-1-6')
    expect(session?.totalTokens).toBe(19)
    expect(session?.messageCount).toBe(1)
    expect(session?.previewMessages[0]).toMatchObject({
      role: 'assistant',
      text: 'Done'
    })
  })
})
