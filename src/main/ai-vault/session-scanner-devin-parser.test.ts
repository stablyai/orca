import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    // total_input_tokens already includes cache; the split buckets do not
    // add on top. total = 10 input + 4 output.
    expect(session?.totalTokens).toBe(14)
    expect(session?.messageCount).toBe(1)
    expect(session?.previewMessages[0]).toMatchObject({
      role: 'assistant',
      text: 'Done'
    })
  })

  it('adds cache buckets on top of the legacy input_tokens split', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'legacy.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'legacy',
        steps: [
          {
            metadata: {
              created_at: '2026-05-26T00:00:00Z',
              metrics: {
                input_tokens: 10,
                output_tokens: 4,
                cache_read_tokens: 3,
                cache_creation_tokens: 2
              }
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

    // Legacy input_tokens excludes cache: 10 + 3 read + 2 creation + 4 out.
    expect(session?.totalTokens).toBe(19)
  })

  it('lets a positive metric win over an explicit zero in an earlier source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'zero.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'zero',
        steps: [
          {
            timestamp: '2026-05-26T00:00:00Z',
            metadata: { metrics: { prompt_tokens: 0, completion_tokens: 0 } },
            metrics: { prompt_tokens: 50, completion_tokens: 8 }
          }
        ]
      })
    )

    const session = await parseDevinSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session?.totalTokens).toBe(58)
  })

  it('parses a real ATIF-v1.7 transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'apricot-houseboat.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 'ATIF-v1.7',
        session_id: 'apricot-houseboat',
        agent: {
          name: 'devin',
          version: '3000.10.27',
          model_name: 'SWE-2 High',
          tool_definitions: []
        },
        steps: [
          {
            step_id: 8,
            timestamp: '2026-09-16T09:50:40.000000000+00:00',
            source: 'system',
            message: 'You are Devin, an AI software engineer.'
          },
          {
            step_id: 9,
            timestamp: '2026-09-16T09:50:55.745112900+00:00',
            source: 'user',
            message: 'fix toàn bộ các lỗi này đi',
            extra: { telemetry: { source: 'user', operation: 'unknown' } }
          },
          {
            step_id: 10,
            timestamp: '2026-09-16T09:51:02.1+00:00',
            source: 'agent',
            message: '# Báo cáo\n\nĐã sửa xong.',
            tool_calls: [],
            model_name: 'swe-2-high',
            metrics: { prompt_tokens: 174988, completion_tokens: 2061, cached_tokens: 170575 },
            extra: {
              generation_model: 'swe-2-high',
              telemetry: { source: 'assistant', operation: 'inference' }
            }
          },
          {
            step_id: 11,
            timestamp: '2026-09-16T09:51:30.0+00:00',
            source: 'agent',
            message: 'All checks pass.',
            metrics: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 50 },
            extra: { telemetry: { source: 'assistant', operation: 'inference' } }
          }
        ],
        final_metrics: {
          total_prompt_tokens: 175088,
          total_completion_tokens: 2071,
          total_cached_tokens: 170625,
          total_steps: 11
        }
      })
    )

    const session = await parseDevinSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session).not.toBeNull()
    expect(session?.sessionId).toBe('apricot-houseboat')
    expect(session?.model).toBe('SWE-2 High')
    expect(session?.title).toBe('fix toàn bộ các lỗi này đi')
    expect(session?.messageCount).toBe(3)
    // prompt + completion per step; cached_tokens is already inside prompt_tokens.
    expect(session?.totalTokens).toBe(177159)
    expect(session?.updatedAt).toBe('2026-09-16T09:51:30.000Z')
    expect(session?.previewMessages.length).toBeGreaterThan(0)
    for (const preview of session?.previewMessages ?? []) {
      expect(['user', 'assistant']).toContain(preview.role)
      expect(preview.text).toBeTruthy()
    }
    expect(session?.previewMessages.some((preview) => preview.role === 'user')).toBe(true)
    expect(session?.previewMessages.some((preview) => preview.role === 'assistant')).toBe(true)
  })
})
