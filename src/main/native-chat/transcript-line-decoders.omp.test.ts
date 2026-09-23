import { describe, expect, it } from 'vitest'
import { deriveNativeChatContextUsage } from '../../shared/native-chat-context-usage'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { ompModelSelector, parseOmpModelList } from '../../shared/omp-model-list-probe'
import { decodeOmpTranscriptLine } from './transcript-line-decoders'

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
  it('skips malformed lines and non-conversation records', () => {
    expect(decodeOmpTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'session_init', id: 'a' }), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'mode_change', id: 'a' }), 'f')).toBeNull()
    expect(
      decodeOmpTranscriptLine(line({ type: 'custom', customType: 'tool_execution_start' }), 'f')
    ).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f')).toBeNull()
  })

  it('decodes a user turn', () => {
    const decoded = decodeOmpTranscriptLine(
      message('user', [{ type: 'text', text: 'resume' }]),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'resume' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
  })

  it('keeps thinking and tool calls together on a mixed assistant turn', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'thinking', thinking: 'Checking the goal' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'toolCall', id: 'call-1', name: 'goal', arguments: { op: 'get' } }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: 'Checking the goal' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool-call', name: 'goal', input: { op: 'get' } }
    ])
  })

  it('keeps a thinking-only assistant turn on the assistant role', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'thinking', thinking: 'Weighing two options' }]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Weighing two options' }])
  })

  it('passes tool arguments through unchanged', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'toolCall', name: 'goal', arguments: { op: 'get', objective: null } }
      ]),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'goal',
      input: { op: 'get', objective: null }
    })
  })

  it('decodes a tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'ok' }], {
        toolCallId: 'call-1',
        toolName: 'goal',
        isError: false
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'ok' }])
  })

  it('flags an errored tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'boom' }], {
        toolCallId: 'call-2',
        isError: true
      }),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({ type: 'tool-result', output: 'boom', isError: true })
  })

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

  it('accepts string content on a custom_message', () => {
    const decoded = decodeOmpTranscriptLine(
      line({ type: 'custom_message', id: 'rec-s', display: true, content: 'peer said hi' }),
      'f'
    )
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'peer said hi' }])
  })

  it('renders a bash execution cell as a tool turn', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-b',
        timestamp: '2026-07-16T00:27:02.222Z',
        message: { role: 'bashExecution', command: 'ls -a', output: '.git\n', exitCode: 0 }
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: 'ls -a' },
      { type: 'tool-result', output: '.git\n' }
    ])
  })

  it('flags a nonzero exit code and reads python cells from `code`', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-p',
        message: {
          role: 'pythonExecution',
          code: 'raise SystemExit(2)',
          output: 'boom',
          exitCode: 2
        }
      }),
      'f'
    )
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'python', input: 'raise SystemExit(2)' },
      { type: 'tool-result', output: 'boom', isError: true }
    ])
  })

  // Why: omp's cancel and timeout paths both return `exitCode: undefined`, which
  // JSON.stringify omits — so the record has no exitCode at all and only
  // `cancelled` distinguishes it from a clean run.
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

  // Why: pre-v3 sessions stored extension turns as `type:'message'` with role
  // custom/hookMessage; the display flag gates them exactly as custom_message.
  it('honors the display gate on legacy custom / hookMessage message rows', () => {
    const legacy = (role: string, display: boolean): string =>
      line({
        type: 'message',
        id: 'rec-l',
        message: { role, customType: 'irc:incoming', display, content: 'peer note' }
      })
    expect(decodeOmpTranscriptLine(legacy('custom', false), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(legacy('hookMessage', false), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(legacy('custom', true), 'f')).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'peer note' }]
    })
  })

  it('surfaces the developer channel as system', () => {
    const decoded = decodeOmpTranscriptLine(
      message('developer', [{ type: 'text', text: 'context note' }]),
      'f'
    )
    expect(decoded?.role).toBe('system')
  })

  it('drops blob-handle images, which the renderer cannot load', () => {
    expect(
      decodeOmpTranscriptLine(
        message('user', [{ type: 'image', data: 'blob:sha256:abc', mimeType: 'image/webp' }]),
        'f'
      )
    ).toBeNull()
  })

  it('surfaces an aborted turn as the interrupted row, not silence', () => {
    // Why: omp stamps `stopReason: 'aborted'` on the assistant message itself and
    // leaves the content empty when nothing streamed, so the turn used to decode
    // to null and vanish. Claude and Codex both emit this row for their aborts.
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: '' }], {
        stopReason: 'aborted',
        errorMessage: 'Stopped before model call'
      }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Conversation interrupted' }])
  })

  it('keeps partial content when a turn aborted mid-stream', () => {
    // omp spreads the in-flight message and stamps the abort on it, so a partial
    // answer is real conversation and must not be replaced by the status row.
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: 'Partial answer' }], { stopReason: 'aborted' }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Partial answer' }])
  })

  it('still drops an empty non-aborted assistant turn', () => {
    expect(
      decodeOmpTranscriptLine(message('assistant', [{ type: 'text', text: '' }]), 'f')
    ).toBeNull()
  })

  it('falls back to the supplied id when the record carries none', () => {
    const decoded = decodeOmpTranscriptLine(
      line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      'fallback-9'
    )
    expect(decoded?.id).toBe('fallback-9')
    expect(decoded?.timestamp).toBeNull()
  })

  describe('what served a reply, and the prompt it read', () => {
    // An assistant row as OMP 17.0.5 writes it, provider payload and ids trimmed.
    const reply = (extra: Record<string, unknown> = {}): string =>
      message('assistant', [{ type: 'text', text: 'The `value` field is set to **42**.' }], {
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        usage: {
          input: 680,
          output: 16,
          cacheRead: 20992,
          cacheWrite: 0,
          totalTokens: 21688,
          cost: {
            input: 0.0034,
            output: 0.00048,
            cacheRead: 0.010496,
            cacheWrite: 0,
            total: 0.014376
          }
        },
        stopReason: 'stop',
        contextSnapshot: { promptTokens: 21672, nonMessageTokens: 20318 },
        ...extra
      })

    it('keeps the provider, model and usage of a completed reply', () => {
      expect(decodeOmpTranscriptLine(reply(), 'f')).toMatchObject({
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        usage: {
          inputTokens: 680,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 20992,
          outputTokens: 16
        }
      })
    })

    it('drops the accounting of an aborted or errored reply, keeping its model', () => {
      for (const stopReason of ['aborted', 'error']) {
        const decoded = decodeOmpTranscriptLine(reply({ stopReason }), 'f')
        expect(decoded?.model).toBe('gpt-5.5')
        expect(decoded).not.toHaveProperty('usage')
      }
    })

    it("measures the prompt OMP recorded, against its listing's window for that model", () => {
      // A `omp models --json` row as OMP 17.0.5 prints it.
      const listing = parseOmpModelList(
        line({
          models: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.5',
              selector: 'openai-codex/gpt-5.5',
              name: 'GPT-5.5',
              contextWindow: 272000
            }
          ]
        })
      )
      const windowFor = (served: NativeChatMessage): number | null =>
        listing.find(({ id }) => id === ompModelSelector(served.provider, served.model))
          ?.contextWindowTokens ?? null
      const decoded = decodeOmpTranscriptLine(reply(), 'f')!
      // 21,672 is the `contextSnapshot.promptTokens` OMP stored on this reply.
      expect(deriveNativeChatContextUsage([decoded], windowFor)).toEqual({
        usedTokens: 21672,
        windowTokens: 272000,
        percentage: 8
      })
      const compaction = decodeOmpTranscriptLine(line({ type: 'compaction', id: 'c' }), 'f')!
      expect(deriveNativeChatContextUsage([decoded, compaction], windowFor)).toBeNull()
    })

    it('puts none of it on turns that are not replies', () => {
      const decoded = decodeOmpTranscriptLine(
        message('user', [{ type: 'text', text: 'hi' }], { model: 'gpt-5.5', usage: { input: 5 } }),
        'f'
      )
      expect(decoded).not.toHaveProperty('usage')
      expect(decoded).not.toHaveProperty('model')
    })
  })

  it('marks a compaction row as the boundary it draws', () => {
    // Field shape of `appendCompaction` in OMP 17.0.5; summary text elided.
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'compaction',
        id: 'cmp-1',
        parentId: 'rec-9',
        timestamp: '2026-07-16T01:00:00.000Z',
        summary: '…',
        shortSummary: '…',
        firstKeptEntryId: 'rec-7',
        tokensBefore: 180000
      }),
      'f'
    )
    expect(decoded).toEqual({
      id: 'cmp-1',
      role: 'system',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
      timestamp: Date.parse('2026-07-16T01:00:00.000Z'),
      source: 'transcript'
    })
  })
})
