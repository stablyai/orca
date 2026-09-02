import { describe, expect, it } from 'vitest'
import {
  boundWorkerTranscriptMessages,
  redactWorkerTerminalLines
} from './worker-transcript-payload'

describe('worker transcript wire bounds', () => {
  it('clips oversized blocks and omits local image paths', () => {
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-1',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          { type: 'text', text: 'x'.repeat(5_000) },
          { type: 'image-ref', path: 'C:\\Users\\worker\\secret.png', alt: 'screenshot' }
        ]
      }
    ])

    expect(result.messages[0]?.blocks[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('… (truncated)')
    })
    expect(result.messages[0]?.blocks[1]).toEqual({
      type: 'image-ref',
      alt: 'screenshot'
    })
    expect(JSON.stringify(result)).not.toContain('C:\\\\Users')
    expect(result.warnings).toContain('Local image paths were omitted from transcript output.')
  })

  it('keeps fallback identifiers stable without exposing the transcript path', () => {
    const transcriptPath = 'C:\\Users\\worker\\.codex\\session.jsonl'
    const message = {
      id: `${transcriptPath}:0000000000000042`,
      turnId: `${transcriptPath}:0000000000000001`,
      role: 'assistant' as const,
      timestamp: null,
      source: 'transcript' as const,
      blocks: [{ type: 'image-ref' as const, url: `file:///${transcriptPath}` }]
    }

    const first = boundWorkerTranscriptMessages([message], transcriptPath)
    const second = boundWorkerTranscriptMessages([message], transcriptPath)

    expect(first.messages).toEqual(second.messages)
    expect(first.messages[0]?.id).toMatch(/^worker-message-/)
    expect(first.messages[0]?.turnId).toMatch(/^worker-message-/)
    expect(first.messages[0]?.blocks[0]).toEqual({ type: 'image-ref' })
    expect(JSON.stringify(first)).not.toContain('Users')
    expect(first.warnings).toEqual(
      expect.arrayContaining([
        'Transcript-backed message identifiers were made opaque.',
        'Local image paths were omitted from transcript output.'
      ])
    )
  })

  it('redacts dispatch capabilities from prose and tool payloads', () => {
    const capability = `dcap_${'A'.repeat(43)}`
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-secret',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          { type: 'text', text: `Use --dispatch-capability ${capability}` },
          {
            type: 'tool-call',
            name: 'exec_command',
            input: {
              cmd: `orca orchestration send --dispatch-capability ${capability}`,
              [capability]: 'secret key'
            }
          },
          { type: 'tool-result', output: `echoed ${capability}` }
        ]
      }
    ])

    expect(JSON.stringify(result)).not.toContain(capability)
    expect(JSON.stringify(result.messages)).toContain('[dispatch capability redacted]')
    expect(result.warnings).toContain(
      'Dispatch capability tokens were redacted from transcript output.'
    )
  })

  it('redacts dispatch capabilities from terminal fallback lines', () => {
    const capability = `dcap_${'A'.repeat(43)}`

    expect(redactWorkerTerminalLines([`send --dispatch-capability ${capability}`, 'safe'])).toEqual(
      {
        lines: ['send --dispatch-capability [dispatch capability redacted]', 'safe'],
        warnings: ['Dispatch capability tokens were redacted from terminal output.']
      }
    )
  })
})
