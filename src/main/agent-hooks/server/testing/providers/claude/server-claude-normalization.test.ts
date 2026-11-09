import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../../../agent-hook-server'
import { buildBody } from '../../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude hook normalization', () => {
  it('flags a PostToolUse preview as tool output so native chat will not show it as the reply', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat lifecycle.ts' },
        tool_response: { content: [{ type: 'text', text: 'Exit code 1\nimport { Foo }' }] }
      }),
      'production'
    )
    expect(result?.payload.lastAssistantMessage).toBe('Exit code 1\nimport { Foo }')
    expect(result?.payload.lastAssistantMessageIsToolOutput).toBe(true)
  })

  it('flags a PostToolUseFailure preview as tool output', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Write',
        error: 'file is read-only'
      }),
      'production'
    )
    expect(result?.payload.lastAssistantMessage).toBe('file is read-only')
    expect(result?.payload.lastAssistantMessageIsToolOutput).toBe(true)
  })

  it('leaves real assistant prose at Stop unflagged', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { content: [{ type: 'text', text: 'a.ts b.ts' }] }
      }),
      'production'
    )
    const stopped = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Here are the files.'
      }),
      'production'
    )
    expect(stopped?.payload.lastAssistantMessage).toBe('Here are the files.')
    expect(stopped?.payload.lastAssistantMessageIsToolOutput).toBeUndefined()
  })

  it('StopFailure maps to done without copying provider error text', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'say hi'
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'StopFailure',
        error: 'invalid_request',
        error_details: 'model is not supported',
        last_assistant_message: 'API Error: model is not supported'
      }),
      'production'
    )

    expect(result?.payload.state).toBe('done')
    expect(result?.payload.prompt).toBe('say hi')
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  describe('Stop transcript scan', () => {
    let tmpDir: string
    let transcriptPath: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'orca-hook-test-'))
      transcriptPath = join(tmpDir, 'transcript.jsonl')
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('skips tool_use-only assistant entries to find the previous text reply', () => {
      const lines = [
        { role: 'assistant', message: { role: 'assistant', content: 'the answer is 42' } },
        {
          role: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]
          }
        }
      ]
      writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

      const result = _internals.normalizeHookPayload(
        'claude',
        buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
        'production'
      )
      expect(result?.payload.lastAssistantMessage).toBe('the answer is 42')
    })

    it('finds an assistant reply that sits past the first chunk boundary', () => {
      // Large tool results force the backward scan beyond its first 64-KB chunk.
      const filler = 'x'.repeat(70_000)
      const lines = [
        { role: 'assistant', message: { role: 'assistant', content: 'deeply buried reply' } },
        {
          role: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: filler }]
          }
        },
        {
          role: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]
          }
        }
      ]
      writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

      const result = _internals.normalizeHookPayload(
        'claude',
        buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
        'production'
      )
      expect(result?.payload.lastAssistantMessage).toBe('deeply buried reply')
    })
  })
})
