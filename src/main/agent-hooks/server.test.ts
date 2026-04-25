/* eslint-disable max-lines -- Why: this suite exercises the full hook HTTP surface (Claude/Codex/Gemini parsing, transcript chunked scan, paneKey dispatch) and keeping the scenarios co-located avoids fixture drift across files. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentHookServer, _internals } from './server'

const PANE = 'tab-1:0'

type Body = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  payload: Record<string, unknown>
}

function buildBody(payload: Record<string, unknown>, overrides: Partial<Body> = {}): Body {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    env: 'production',
    payload,
    ...overrides
  }
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('replays the latest retained pane status when a listener attaches after windowless events', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'UserPromptSubmit',
            prompt: 'replay me'
          })
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: expect.objectContaining({
          state: 'working',
          prompt: 'replay me',
          agentType: 'claude'
        })
      })
    } finally {
      server.stop()
    }
  })

  it('does not replay cleared pane state to a newly attached listener', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'UserPromptSubmit',
            prompt: 'clear me'
          })
        )
      })

      server.clearPaneState(PANE)
      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('accepts form-encoded hook posts from Unix managed scripts', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const params = new URLSearchParams({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'repo::/tmp/worktree with "quotes"',
        env: 'production',
        version: env.ORCA_AGENT_HOOK_VERSION ?? '',
        payload: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'form encoded'
        })
      })

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: params
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'repo::/tmp/worktree with "quotes"',
        payload: expect.objectContaining({
          state: 'working',
          prompt: 'form encoded',
          agentType: 'claude'
        })
      })
    } finally {
      server.stop()
    }
  })
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
    // Why: we use a per-tool allowlist to decide which field to preview.
    // Tools we do not recognize render as name-only rather than guessing at
    // a field, which avoids noisy/misleading previews (e.g. an opaque ID).
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
    // Why: TaskUpdate's tool_input (e.g. { task_id: "3", status: "in_progress" })
    // has no meaningful preview — rendering "3" is actively confusing. The
    // allowlist approach leaves toolInput undefined for unlisted tools.
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

  it('PostToolUseFailure surfaces the error text as lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/config.ts' },
        error: 'file is read-only'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Edit')
    expect(result?.payload.lastAssistantMessage).toBe('file is read-only')
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
      // Why: a turn with many large tool_result entries pushes the final text
      // reply well past the first 64 KB chunk; the chunked scan should keep
      // reading backward until it finds it.
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
    // Stop event has no tool fields of its own — merged snapshot should still
    // carry the earlier PreToolUse values.
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

describe('Codex hook normalization', () => {
  it('Stop carries last_assistant_message into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Summary of what I did.'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('Summary of what I did.')
  })

  it('PreToolUse surfaces tool name + input preview and stays in working state', () => {
    // Why: Codex's PreToolUse is NOT an approval prompt — it fires for every
    // tool call. We map it to `working` (never `waiting`) and use it only to
    // give the dashboard a live readout during the gap between prompt and
    // Stop. Real approval signals flow through Codex's `notify` callback.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git status', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('UserPromptSubmit does not extract tool fields even when the payload carries them', () => {
    // Why: UserPromptSubmit is a turn-boundary event; any tool_name on it
    // would be leftover noise and should not leak into the working-state
    // preview. Tool extraction is gated to PreToolUse/PostToolUse.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Hello',
        tool_name: 'Edit',
        tool_input: { file_path: '/ignored.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('SessionStart clears cached tool state from a prior session', () => {
    // Seed a Stop snapshot with an assistant message.
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Previous run finished'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('SessionStart clears the cached prompt from a prior session until a new prompt arrives', () => {
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'stale prompt'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('')
  })
})

describe('Gemini hook normalization', () => {
  it('PreToolUse surfaces toolName + toolInput', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'read_file',
        tool_input: { path: '/src/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('read_file')
    expect(result?.payload.toolInput).toBe('/src/index.ts')
  })

  it('falls back to args when tool_input is absent', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'run_shell_command',
        args: { command: 'git status' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('run_shell_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('BeforeAgent clears the cached tool state from a prior turn', () => {
    _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'read_file',
        tool_input: { path: '/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({ hook_event_name: 'BeforeAgent' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('AfterAgent reports done without introducing tool fields on its own', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({ hook_event_name: 'AfterAgent' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.toolName).toBeUndefined()
  })

  it('AfterAgent carries prompt_response into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'AfterAgent',
        prompt: 'what did you do',
        prompt_response: 'I ran the tests and they passed.',
        stop_hook_active: false
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('I ran the tests and they passed.')
  })
})

describe('OpenCode hook normalization', () => {
  it('SessionBusy maps to working', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('opencode')
  })

  it('SessionBusy does NOT clear the cached user prompt', () => {
    // Why: OpenCode emits the user's MessagePart (message.updated) *before*
    // SessionBusy fires — the session goes idle→busy only after OpenCode begins
    // processing the prompt. So the cached prompt at SessionBusy is the current
    // turn's prompt, not the previous turn's. Clearing on SessionBusy would
    // clobber the data the dashboard needs to render for this turn.
    _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'new prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new prompt')
  })

  it('SessionIdle maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('opencode')
  })

  it('PermissionRequest maps to waiting', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SomeOtherEvent' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('MessagePart with role=user surfaces text as the prompt and stays working', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'hi there' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('hi there')
  })

  it('MessagePart with role=assistant populates lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'Hello! How can I help?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Hello! How can I help?')
  })

  it('subsequent SessionIdle preserves cached prompt + assistant message', () => {
    _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'hi' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'assistant', text: 'hello back' }),
      'production'
    )
    const done = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('hi')
    expect(done?.payload.lastAssistantMessage).toBe('hello back')
  })
})
