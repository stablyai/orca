/* eslint-disable max-lines -- Why: this suite exercises the full hook HTTP surface (Claude/Codex/Gemini parsing, transcript chunked scan, paneKey dispatch) and keeping the scenarios co-located avoids fixture drift across files. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentHookServer, _internals } from './server'
import { parseAgentStatusPayload } from '../../shared/agent-status-types'

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
        connectionId: null,
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
        connectionId: null,
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

  it('AskUserQuestion maps to waiting', () => {
    // Why: OpenCode emits `question.asked` when the agent uses an ask-the-user
    // tool (distinct from `permission.asked`, which blocks on tool approval).
    // Both leave the agent idle-but-waiting on a human, so both must render
    // the same red "needs attention" indicator. Without this mapping the pane
    // silently stays in `working` and the user has no visual cue that the
    // agent is waiting on them.
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'AskUserQuestion' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe('opencode')
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

describe('Cursor hook normalization', () => {
  it('beforeSubmitPrompt maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'add a README' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.prompt).toBe('add a README')
  })

  it('stop maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.interrupted).toBeUndefined()
  })

  it('stop with non-completed status marks the turn interrupted', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'cancelled' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.interrupted).toBe(true)
  })

  it('beforeShellExecution maps to waiting with the pending command as toolInput', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeShellExecution', command: 'rm -rf /tmp/foo' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('Shell')
    expect(result?.payload.toolInput).toBe('rm -rf /tmp/foo')
  })

  it('beforeMCPExecution maps to waiting', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeMCPExecution', tool_name: 'fetch', url: 'https://x' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('fetch')
  })

  it('preToolUse surfaces tool name + input preview and stays working', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/app.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/repo/src/app.ts')
  })

  it('afterAgentResponse carries text into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'afterAgentResponse', text: 'Done — wrote the README.' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Done — wrote the README.')
  })

  it('beforeSubmitPrompt clears the cached tool state from a prior turn', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'new turn' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new turn')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('subsequent stop preserves the cached prompt from beforeSubmitPrompt', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'add tests' }),
      'production'
    )
    const stop = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('add tests')
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'somethingElse' }),
      'production'
    )
    expect(result).toBeNull()
  })
})

describe('Pi hook normalization', () => {
  it('before_agent_start maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'rename this fn' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('pi')
    expect(result?.payload.prompt).toBe('rename this fn')
  })

  it('agent_start without a prompt keeps the cached prompt from the current turn', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'first prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_start' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('first prompt')
  })

  it('before_agent_start clears the previous turn’s tool cache', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_call',
        tool_name: 'bash',
        tool_input: { command: 'ls' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'next' }),
      'production'
    )
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('tool_call surfaces tool_name + tool_input preview', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_call',
        tool_name: 'bash',
        tool_input: { command: 'pnpm test' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('bash')
    expect(result?.payload.toolInput).toBe('pnpm test')
  })

  it('tool_execution_start also populates the tool preview', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_execution_start',
        tool_name: 'read',
        tool_input: { path: 'src/main/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('read')
    expect(result?.payload.toolInput).toBe('src/main/index.ts')
  })

  it('message_end (assistant) stays in working but captures lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'message_end',
        role: 'assistant',
        text: 'Done — I refactored the helper.'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Done — I refactored the helper.')
  })

  it('message_end (user) is ignored', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'message_end', role: 'user', text: 'hi' }),
      'production'
    )
    // Why: pi captures the user prompt via before_agent_start, not via
    // message_end. A user-role message_end should not flip lastAssistantMessage.
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('agent_end maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_end' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('pi')
  })

  it('session_shutdown maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'session_shutdown' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
  })

  it('done preserves the cached lastAssistantMessage from a prior message_end', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'message_end',
        role: 'assistant',
        text: 'final reply'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_end' }),
      'production'
    )
    expect(result?.payload.lastAssistantMessage).toBe('final reply')
  })

  it('unknown event names are dropped', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'never_heard_of_it' }),
      'production'
    )
    expect(result).toBeNull()
  })
})

describe('Endpoint file lifecycle', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-endpoint-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('writes the endpoint file with the expected shell-sourceable shape', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'development', userDataPath })
    try {
      const filePath = server.endpointFilePath
      expect(filePath).toBeTruthy()
      expect(existsSync(filePath!)).toBe(true)
      const contents = readFileSync(filePath!, 'utf8')
      const expectedPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      const expectedToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
      const prefix = process.platform === 'win32' ? 'set ' : ''
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_PORT=${expectedPort}`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_TOKEN=${expectedToken}`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_ENV=development`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_VERSION=1`)
    } finally {
      server.stop()
    }
  })

  it('writes the endpoint file with owner-only permissions on POSIX', async () => {
    if (process.platform === 'win32') {
      return
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const filePath = server.endpointFilePath!
      // Why: mask off type/setuid bits so we assert only the rwx octet that
      // writeFileSync(mode:0o600) sets. A leaky umask at dir-create time can
      // leave group/other bits on the *parent* dir but not on the file itself.
      const mode = statSync(filePath).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      server.stop()
    }
  })

  it('rewrites the endpoint file with a new port after restart on the same path', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const firstPath = server.endpointFilePath
    const firstToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
    server.stop()

    await server.start({ env: 'production', userDataPath })
    try {
      const secondPath = server.endpointFilePath
      const secondPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      const secondToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
      // Path is stable (so PTYs stamped before restart can still find the file)
      expect(secondPath).toBe(firstPath)
      // But contents are refreshed with the new token (and port) — that is the
      // whole point of the design: survivors reading a stale-env file reach the
      // live server. Why token-first: the token is randomUUID()-minted per
      // start(), so it is guaranteed to differ across restarts. The port comes
      // from listen(0) and the kernel can legitimately reassign the same
      // ephemeral port, so asserting port-inequality would be a latent flake.
      expect(secondToken).toBeTruthy()
      expect(secondToken).not.toBe(firstToken)
      const contents = readFileSync(secondPath!, 'utf8')
      // Why: token-based content check is the rewrite signal. A strict
      // "contents does NOT contain firstPort" assertion would flake on the
      // (rare but legitimate) case where listen(0) reuses the same ephemeral
      // port across restarts. The token is randomUUID() and cannot collide.
      expect(contents).toContain(`ORCA_AGENT_HOOK_PORT=${secondPort}`)
      expect(contents).toContain(`ORCA_AGENT_HOOK_TOKEN=${secondToken}`)
      expect(contents).not.toContain(`ORCA_AGENT_HOOK_TOKEN=${firstToken}`)
    } finally {
      server.stop()
    }
  })

  it('leaves the endpoint file in place on stop()', async () => {
    // Why: stop() deliberately does NOT unlink the endpoint file. A stale file
    // points at a dead port — the fail-open path (hook POSTs silently fail,
    // same as pre-endpoint-file). Unlinking would introduce a TOCTOU race with a
    // concurrent Orca instance sharing userData that could rewrite the file
    // between our token check and unlink. The next successful start()
    // overwrites the file atomically; tmp-file orphan hygiene is handled by
    // the sweep inside writeEndpointFile().
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const filePath = server.endpointFilePath!
    expect(existsSync(filePath)).toBe(true)
    server.stop()
    expect(existsSync(filePath)).toBe(true)
  })

  it('buildPtyEnv includes ORCA_AGENT_HOOK_ENDPOINT when the server is running', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBe(server.endpointFilePath)
    } finally {
      server.stop()
    }
  })

  it('buildPtyEnv omits ORCA_AGENT_HOOK_ENDPOINT when no userDataPath was provided', async () => {
    // Why: the endpoint file is opt-in via start({ userDataPath }). In tests
    // and in the packaged main-process path where userData is unset for any
    // reason, hooks should fall back to the v1 behavior (no ENDPOINT key).
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('buildPtyEnv returns empty when the server is not running', () => {
    const server = new AgentHookServer()
    expect(server.buildPtyEnv()).toEqual({})
  })

  it('sweeps stale .endpoint-*.tmp orphans older than 5 minutes on start', async () => {
    // Why: writeEndpointFile() writes to a unique tmp path then renames. A crash
    // between write and rename leaves an orphan tmp; the sweep inside
    // writeEndpointFile() must drop ones older than 5 min without touching
    // fresh ones (a concurrent writer's in-flight tmp).
    const dir = join(userDataPath, 'agent-hooks')
    mkdirSync(dir, { recursive: true })
    const staleTmp = join(dir, '.endpoint-999-stale.tmp')
    const freshTmp = join(dir, '.endpoint-999-fresh.tmp')
    writeFileSync(staleTmp, 'stale')
    writeFileSync(freshTmp, 'fresh')
    const sixMinAgo = (Date.now() - 6 * 60 * 1000) / 1000
    utimesSync(staleTmp, sixMinAgo, sixMinAgo)

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(existsSync(staleTmp)).toBe(false)
      expect(existsSync(freshTmp)).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('refuses to write the endpoint file when a value contains shell metacharacters', async () => {
    // Why: every value written is sourced as shell. The isShellSafeEndpointValue
    // allowlist must reject a metacharacter-bearing value so a future caller
    // cannot command-inject via the sourced file. `env` is the only caller-
    // provided field we can easily poison from a test — feed it a semicolon
    // and assert the file is not written and buildPtyEnv() omits the ENDPOINT
    // key (gated on endpointFileWritten).
    const server = new AgentHookServer()
    await server.start({ env: 'bad;value', userDataPath })
    try {
      expect(existsSync(server.endpointFilePath!)).toBe(false)
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      // PORT/TOKEN still flow via PTY env — fail-open to v1 behavior.
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('endpoint file contents are re-parseable by /bin/sh', async () => {
    if (process.platform === 'win32') {
      return
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const filePath = server.endpointFilePath!
      const expectedPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      // Why: sources the file in a subshell and echoes the resulting env var,
      // exactly as the managed hook script does at runtime. If the file shape
      // ever drifts from `KEY=VALUE` (e.g. someone adds shell metacharacters
      // without quoting), this test catches it before users do.
      const out = execFileSync('/bin/sh', ['-c', `. "${filePath}" && echo "$ORCA_AGENT_HOOK_PORT"`])
        .toString()
        .trim()
      expect(out).toBe(expectedPort)
    } finally {
      server.stop()
    }
  })
})

describe('AgentHookServer ingestRemote', () => {
  it('stamps connectionId and forwards a valid relay envelope to the listener', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'conn-1',
      payload
    })
  })

  it('drops envelopes whose payload state is not in AGENT_STATUS_STATES', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    // Why: bypass parseAgentStatusPayload (which itself rejects bad states) by
    // constructing an obviously-invalid payload — `ingestRemote` is the trust
    // boundary we're testing, not the parser.
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'nonsense', prompt: '', agentType: 'claude' }
      },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops envelopes whose paneKey exceeds MAX_PANE_KEY_LEN', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    // 201 chars — one past the listener's 200-char cap.
    const oversized = 'a'.repeat(201)
    server.ingestRemote(
      { paneKey: oversized, tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects empty connectionId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload },
      ''
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only connectionId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload },
      '   '
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects non-string tabId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 123 as unknown as string, worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects empty paneKey after trim', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: '   ', tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('normalizes inner payload via normalizeAgentStatusPayload — clamps oversized prompt', () => {
    // Why: the relay normally normalizes the payload on the wire, but a buggy
    // or malicious relay could forward an over-cap field. ingestRemote must
    // re-run the canonical normalizer so the AGENT_STATUS_MAX_FIELD_LENGTH
    // cap (200 chars) is enforced at the trust boundary.
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'x'.repeat(500), agentType: 'claude' }
      },
      'conn-1'
    )
    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as { payload: { prompt: string } }
    expect(event.payload.prompt.length).toBe(200)
  })
})
