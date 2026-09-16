import { describe, expect, it } from 'vitest'
import { MAX_CODEX_SUBAGENTS_PER_GROUP } from '../../codex/codex-structured-journal-limits'
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
    expect(result.limited).toBe(true)
    expect(result.warnings).toContain('Local image paths were omitted from transcript output.')
  })

  it('marks text, block-count, and tool-input clipping as limited', () => {
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-clipped',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          { type: 'text', text: 'x'.repeat(5_000) },
          { type: 'tool-call', name: 'Write', input: { content: 'y'.repeat(5_000) } },
          ...Array.from({ length: 6 }, () => ({ type: 'text' as const, text: 'extra' }))
        ]
      }
    ])

    expect(result.limited).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Some transcript blocks were omitted from oversized messages.',
        'Oversized transcript text was clipped.',
        'Oversized tool input was clipped.'
      ])
    )
  })

  // The bound matches the producer's per-group cap, so nothing this build writes
  // is clipped here. It stays because the journal schema declares no maximum and
  // a remote host may run a build with a larger one — the transport's own
  // invariant that no single block is huge.
  it('caps and redacts a spawn group the way every other collection is capped', () => {
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-roster',
        role: 'system',
        timestamp: null,
        source: 'transcript',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'thread-1:turn-1',
            agents: Array.from({ length: 80 }, (_unused, index) => ({
              id: `child-${index}`,
              label: index === 0 ? `dcap_${'A'.repeat(24)}` : 'read',
              state: 'working' as const
            }))
          }
        ]
      }
    ])

    const block = result.messages[0]?.blocks[0]
    expect(block?.type).toBe('subagent-group')
    expect(block?.type === 'subagent-group' ? block.agents : []).toHaveLength(
      MAX_CODEX_SUBAGENTS_PER_GROUP
    )
    expect(JSON.stringify(result.messages)).not.toContain('dcap_')
    expect(result.limited).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Some subagents were omitted from oversized spawn groups.',
        'Dispatch capability tokens were redacted from transcript output.'
      ])
    )
  })

  it('bounds a spawn-group state a newer build wrote as an oversized open string', () => {
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-roster-state',
        role: 'system',
        timestamp: null,
        source: 'transcript',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'g'.repeat(900),
            agents: [
              {
                id: 'i'.repeat(900),
                label: 'l'.repeat(900),
                state: 's'.repeat(900) as 'working'
              }
            ]
          }
        ]
      }
    ])

    const block = result.messages[0]?.blocks[0]
    const agent = block?.type === 'subagent-group' ? block.agents[0] : undefined
    expect(block?.type === 'subagent-group' ? block.groupId.length : 0).toBe(512)
    expect(agent?.id.length).toBe(512)
    expect(agent?.label.length).toBe(512)
    // A clipped state names no state any build knows, which is what
    // `unverifiable` records — a 512-character fragment is not a state at all.
    expect(agent?.state).toBe('unverifiable')
    expect(result.limited).toBe(true)
  })

  it('keeps complete bounded messages unlimited', () => {
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-complete',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'complete' }]
      }
    ])

    expect(result).toMatchObject({ limited: false, warnings: [] })
  })

  it('keeps two roster ids sharing a 512-char prefix distinct', () => {
    // The id is the roster key: a plain prefix clip would merge the two children.
    const head = 'a'.repeat(512)
    const result = boundWorkerTranscriptMessages([
      {
        id: 'message-1',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'g',
            agents: [
              { id: `${head}-one`, label: 'Audit', state: 'working' },
              { id: `${head}-two`, label: 'Audit', state: 'working' }
            ]
          }
        ]
      }
    ])

    const block = result.messages[0]?.blocks[0]
    if (block?.type !== 'subagent-group') {
      throw new Error('expected a subagent-group block')
    }
    expect(block.agents[0]?.id).not.toBe(block.agents[1]?.id)
    expect(block.agents[0]?.id).toHaveLength(512)
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
