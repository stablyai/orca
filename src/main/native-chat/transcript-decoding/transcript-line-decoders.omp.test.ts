import { describe, expect, it } from 'vitest'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

const line = (record: unknown): string => JSON.stringify(record)

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'message',
    id: 'rec-1',
    parentId: 'rec-0',
    timestamp: '2026-07-16T00:27:02.222Z',
    message: { role, content, ...extra }
  })

describe('decodeOmpTranscriptLine', () => {
  it('surfaces a displayed custom_message, and hides a state-only one', () => {
    const custom = (display: boolean): string =>
      line({
        type: 'custom_message',
        id: 'rec-c',
        customType: 'rewind-report',
        display,
        content: [{ type: 'text', text: 'Investigation summary' }],
        timestamp: '2026-07-16T00:27:02.222Z'
      })
    expect(decodeOmpTranscriptLine(custom(true), 'f')).toEqual({
      id: 'rec-c',
      role: 'system',
      blocks: [{ type: 'text', text: 'Investigation summary' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
    expect(decodeOmpTranscriptLine(custom(false), 'f')).toBeNull()
  })

  it('marks a cancelled run, which carries no exitCode at all', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-c1',
        message: { role: 'bashExecution', command: 'sleep 99', output: 'partial', cancelled: true }
      }),
      'f'
    )
    expect(decoded?.blocks[1]).toEqual({ type: 'tool-result', output: 'partial', isError: true })
  })

  it('lists file mention paths without dumping their auto-read contents', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-f',
        message: {
          role: 'fileMention',
          files: [
            { path: 'src/a.ts', content: 'SECRET FILE BODY' },
            { path: 'src/b.ts' },
            { image: true }
          ]
        }
      }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: '@src/a.ts\n@src/b.ts' }])
    expect(JSON.stringify(decoded)).not.toContain('SECRET FILE BODY')
  })

  it('drops blob-handle images, which the renderer cannot load', () => {
    expect(
      decodeOmpTranscriptLine(
        message('user', [{ type: 'image', data: 'blob:sha256:abc', mimeType: 'image/webp' }]),
        'f'
      )
    ).toBeNull()
  })

  it('keeps partial content when a turn aborted mid-stream', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: 'Partial answer' }], { stopReason: 'aborted' }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Partial answer' }])
  })
})
