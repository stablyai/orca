import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
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
  it('PostToolUse for Edit surfaces toolName + file_path preview', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/config.ts', old_string: 'a', new_string: 'b' },
        tool_response: {}
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Edit')
    expect(result?.payload.toolInput).toBe('/src/config.ts')
  })

  it('PostToolUse for Bash surfaces the command string', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test --run' },
        tool_response: { content: [{ type: 'text', text: 'tests passed' }] }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('Bash')
    expect(result?.payload.toolInput).toBe('pnpm test --run')
    expect(result?.payload.lastAssistantMessage).toBe('tests passed')
  })

  it('flags a PostToolUse preview as tool output so native chat will not show it as the reply', () => {
    // Regression: a Bash result rendered verbatim as an immortal "assistant" bubble in
    // mobile native chat. The status card still gets the preview; only its provenance is new.
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
    // The prose turn must not inherit the previous tool result's flag.
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

  it('PostToolUse for Grep surfaces the search pattern', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'foo.*bar', path: '/src' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('Grep')
    expect(result?.payload.toolInput).toBe('foo.*bar')
  })

  it('PostToolUse for an unknown tool surfaces the name without input', () => {
    // Why: a per-tool allowlist picks the preview field; unrecognized tools render name-only to avoid guessing a misleading field (e.g. an opaque ID).
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'BespokeTool',
        tool_input: { irrelevantFlag: true, summary: 'doing the thing' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('BespokeTool')
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('PostToolUse for TaskUpdate does not produce a misleading input preview', () => {
    // Why: TaskUpdate's tool_input has no meaningful preview (rendering "3" is confusing), so the allowlist leaves toolInput undefined.
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'TaskUpdate',
        tool_input: { task_id: '3', status: 'in_progress' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('TaskUpdate')
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('PostToolUseFailure clears stale tool fields until the next PreToolUse', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/config.ts' }
      }),
      'production'
    )
    const failed = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/config.ts' },
        error: 'file is read-only'
      }),
      'production'
    )
    expect(failed?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'file is read-only'
    })
    expect(failed?.payload.toolName).toBeUndefined()
    expect(failed?.payload.toolInput).toBeUndefined()

    const retry = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/src/config.ts' }
      }),
      'production'
    )
    expect(retry?.payload).toMatchObject({
      state: 'working',
      toolName: 'Read',
      toolInput: '/src/config.ts'
    })
  })

  it('PreToolUse normalizes to working + tool fields', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/src/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/src/index.ts')
  })

  it('PermissionRequest normalizes to waiting + tool fields', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('Bash')
    expect(result?.payload.toolInput).toBe('rm -rf build')
  })

  it('PermissionRequest for a fresh tool without input preview clears cached tool input', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'approval-1' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('BespokeTool')
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('PermissionRequest for the same tool without input preview clears cached tool input', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'BespokeTool',
        tool_input: 'old preview'
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'approval-1' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('BespokeTool')
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('PermissionRequest without a tool name does not inherit stale tool details when input is explicit', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_input: { request_id: 'approval-1' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('UserPromptSubmit clears the cached tool state from the prior turn', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Do the next thing'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('Do the next thing')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('Stop carries last_assistant_message directly when present', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'what is up my dude'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('what is up my dude')
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

    it('surfaces the most recent assistant text entry', () => {
      const lines = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', message: { role: 'assistant', content: 'earlier reply' } },
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'final reply' }] }
        }
      ]
      writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

      const result = _internals.normalizeHookPayload(
        'claude',
        buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
        'production'
      )
      expect(result?.payload.lastAssistantMessage).toBe('final reply')
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
      // Why: large tool_result entries push the final reply past the first 64 KB chunk; the scan must keep reading backward to find it.
      const filler = 'x'.repeat(70_000)
      const lines = [
        { role: 'assistant', message: { role: 'assistant', content: 'deeply buried reply' } },
        // 70 KB of tool_result content straddling the first chunk boundary.
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

    it('returns undefined when the transcript has no assistant text at all', () => {
      const lines = [
        { role: 'user', content: 'hi' },
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
      expect(result?.payload.lastAssistantMessage).toBeUndefined()
    })
  })

  it('merges tool fields across consecutive events in the same turn', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' }
      }),
      'production'
    )
    // Stop event has no tool fields, so the merged snapshot must keep the earlier PreToolUse values.
    const stop = _internals.normalizeHookPayload(
      'claude',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.toolName).toBe('Bash')
    expect(stop?.payload.toolInput).toBe('ls -la')
  })
})
