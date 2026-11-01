import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from './session-transcript-consumers'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('parseDevinSessionFile', () => {
  it.each([
    {
      payloadKind: 'message array',
      fields: (text: string) => ({ message: [], content: [{ type: 'text', text }] })
    },
    {
      payloadKind: 'wrapped content',
      fields: (text: string) => ({ message: { content: '' }, text })
    },
    {
      payloadKind: 'text',
      fields: (text: string) => ({ text: '', content: [{ type: 'text', text }] })
    }
  ])('falls back from empty $payloadKind without shortening content', async ({ fields }) => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-fallback-'))
    tempDirs.push(dir)
    const path = join(dir, 'fallback.json')
    const text = `actual request\n${'x'.repeat(5000)}`
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'fallback',
        steps: ['user', 'agent'].map((source) => ({
          source,
          ...fields(text)
        }))
      })
    )
    const messages: TranscriptMessage[] = []
    const session = await withFullFirstUserPromptCapture(() =>
      parseDevinSessionFile({ path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' }, 'linux', {
        active: true,
        push: (message) => messages.push(message)
      })
    )

    expect(messages).toEqual([
      { role: 'user', text, timestamp: null },
      { role: 'assistant', text, timestamp: null }
    ])
    expect(session?.firstUserPrompt).toBe(text)
    expect(session?.title).toMatch(/^actual request /)
    expect(session?.previewMessages.map((message) => message.text.length)).toEqual([220, 220])
  })

  it.each(
    [
      { payloadKind: 'string', fields: (text: string) => ({ message: text }) },
      { payloadKind: 'wrapped string', fields: (text: string) => ({ message: { content: text } }) },
      {
        payloadKind: 'wrapped blocks',
        fields: (text: string) => ({
          message: { content: text.split('\n').map((text) => ({ type: 'text', text })) }
        })
      },
      {
        payloadKind: 'array',
        fields: (text: string) => ({
          message: text.split('\n').map((text) => ({ type: 'text', text }))
        })
      },
      {
        payloadKind: 'content',
        fields: (text: string) => ({
          content: text.split('\n').map((text) => ({ type: 'text', text }))
        })
      },
      { payloadKind: 'text', fields: (text: string) => ({ text }) }
    ].flatMap((payloadKind) => [5000, 256 * 1024 + 1].map((length) => ({ ...payloadKind, length })))
  )(
    'preserves $length-character $payloadKind messages before display limits',
    async ({ fields, length }) => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-devin-content-'))
      tempDirs.push(dir)
      const path = join(dir, 'content.json')
      const text = `  first line\n${'x'.repeat(length)}\nlast line  `
      await writeFile(
        path,
        JSON.stringify({
          session_id: 'content',
          steps: ['user', 'agent'].map((source) => ({ source, ...fields(text) }))
        })
      )
      const messages: TranscriptMessage[] = []
      const session = await withFullFirstUserPromptCapture(() =>
        parseDevinSessionFile(
          { path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
          'linux',
          { active: true, push: (message) => messages.push(message) }
        )
      )

      expect(messages).toEqual(
        ['user', 'assistant'].map((role) => ({
          role,
          text: text.slice(0, 256 * 1024),
          timestamp: null,
          ...(text.length > 256 * 1024 ? { textTruncated: true } : {})
        }))
      )
      expect(session?.firstUserPrompt).toBe(text.trim().slice(0, 256 * 1024))
      expect(session?.title).toHaveLength(96)
      expect(session?.previewMessages.map((message) => message.text.length)).toEqual([220, 220])
    }
  )

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

  it('extracts text from an array-valued ATIF message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-devin-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'array-message.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'array-message',
        agent: {},
        steps: [
          {
            timestamp: '2026-05-26T00:00:00Z',
            source: 'user',
            message: [{ text: 'First part' }, { text: 'second part' }]
          }
        ]
      })
    )

    const session = await parseDevinSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session?.messageCount).toBe(1)
    expect(session?.title).toBe('First part second part')
    expect(session?.previewMessages[0]).toMatchObject({
      role: 'user',
      text: 'First part second part'
    })
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
