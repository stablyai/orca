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
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  parseAgentStatusPayload
} from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const LEAF_4 = '44444444-4444-4444-8444-444444444444'
const LEAF_5 = '55555555-5555-4555-8555-555555555555'
const PANE = makePaneKey('tab-1', LEAF_1)
const GOOD_PANE = makePaneKey('tab-good', LEAF_2)
const OLD_PANE = makePaneKey('tab-old', LEAF_3)
const FRESH_PANE = makePaneKey('tab-fresh', LEAF_4)
const TAB_A_PANE = makePaneKey('tab-A', LEAF_5)

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
  trackMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('allows multiple status-change subscribers to observe the same update', () => {
    const server = new AgentHookServer()
    const first = vi.fn()
    const second = vi.fn()
    server.subscribeStatusChanges(first)
    server.subscribeStatusChanges(second)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(first).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        receivedAt: expect.any(Number),
        observedInCurrentRuntime: true
      })
    ])
    expect(second).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        receivedAt: expect.any(Number),
        observedInCurrentRuntime: true
      })
    ])
  })

  it('keeps status-change subscribers when renderer fanout listener is cleared', () => {
    const server = new AgentHookServer()
    const statusChangeListener = vi.fn()
    const rendererListener = vi.fn()
    server.subscribeStatusChanges(statusChangeListener)
    server.setListener(rendererListener)
    server.setListener(null)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(statusChangeListener).toHaveBeenCalledTimes(1)
    expect(rendererListener).not.toHaveBeenCalled()
  })

  it('unsubscribes status-change listeners without removing the remaining listeners', () => {
    const server = new AgentHookServer()
    const removed = vi.fn()
    const remaining = vi.fn()
    const unsubscribe = server.subscribeStatusChanges(removed)
    server.subscribeStatusChanges(remaining)

    unsubscribe()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(removed).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        observedInCurrentRuntime: true
      })
    ])
  })

  it('notifies status-change subscribers when a working status is dropped or cleared', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.subscribeStatusChanges(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )
    server.dropStatusEntry(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )
    server.clearPaneState(PANE)

    expect(listener).toHaveBeenNthCalledWith(2, [])
    expect(listener).toHaveBeenNthCalledWith(4, [])
  })

  it('hydrates cached statuses as not observed in the current runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-'))
    const firstServer = new AgentHookServer()
    const secondServer = new AgentHookServer()
    try {
      await firstServer.start({ env: 'production', userDataPath: dir })
      firstServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', agentType: 'claude' }
        },
        'conn-1'
      )
      firstServer.flushStatusPersistSync()
      firstServer.stop()

      await secondServer.start({ env: 'production', userDataPath: dir })

      expect(secondServer.getStatusChangeSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          observedInCurrentRuntime: false
        })
      ])
    } finally {
      firstServer.stop()
      secondServer.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          receivedAt: expect.any(Number),
          stateStartedAt: expect.any(Number),
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'replay me',
            agentType: 'claude'
          })
        })
      )
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

  it('maps registered legacy numeric HTTP pane keys to stable pane keys', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.registerPaneKeyAlias('tab-1:0', PANE)
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'legacy pane'
            },
            { paneKey: 'tab-1:0' }
          )
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'legacy pane',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('tracks hook posts with an empty paneKey before dropping them', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'missing pane'
            },
            { paneKey: '' }
          )
        )
      })
      const listener = vi.fn()
      server.setListener(listener)

      expect(response.status).toBe(204)
      expect(listener).not.toHaveBeenCalled()
      expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
        reason: 'empty_pane_key'
      })
    } finally {
      server.stop()
    }
  })

  // Why: agent-status-over-SSH §3 — ingestRemote must run the same warn-once
  // cross-build diagnostics the local HTTP path runs, so a remote source of
  // genuinely stale hooks emits the same signal locally.
  it('runs warn-once env/version diagnostics on relay-forwarded events', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: PANE,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          connectionId: 'conn-1',
          payload: expect.objectContaining({ state: 'working', agentType: 'claude' })
        })
      )

      const warnCalls = warn.mock.calls.map((c) => String(c[0]))
      expect(warnCalls.some((m) => m.includes('v999'))).toBe(true)
      expect(warnCalls.some((m) => m.includes('development') && m.includes('production'))).toBe(
        true
      )

      const warnsAfterFirst = warn.mock.calls.length
      const secondPane = makePaneKey('tab-2', LEAF_2)
      server.ingestRemote(
        {
          paneKey: secondPane,
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: secondPane,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )
      expect(warn.mock.calls.length).toBe(warnsAfterFirst)
      // Why: pin both invariants — warn-once dedupe AND fanout still fires for
      // the second event. Without the second assertion, a future refactor that
      // drops the second event silently would still leave warn-count unchanged.
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      server.stop()
    }
  })

  it('treats remote env as normal relay traffic and normalizes payload at the trust boundary', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      const oversizedPrompt = 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH + 50)
      const remotePane = makePaneKey('tab-3', LEAF_3)
      server.ingestRemote(
        {
          paneKey: ` ${remotePane} `,
          tabId: ' tab-3 ',
          worktreeId: ' wt-3 ',
          env: 'remote',
          version: '1',
          payload: {
            state: 'done',
            prompt: oversizedPrompt,
            agentType: 'codex'
          }
        },
        ' conn-9 '
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: remotePane,
          tabId: 'tab-3',
          worktreeId: 'wt-3',
          connectionId: 'conn-9',
          payload: expect.objectContaining({
            state: 'done',
            agentType: 'codex',
            prompt: 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)
          })
        })
      )
      expect(warn).not.toHaveBeenCalled()
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

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'repo::/tmp/worktree with "quotes"',
          connectionId: null,
          receivedAt: expect.any(Number),
          stateStartedAt: expect.any(Number),
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'form encoded',
            agentType: 'claude'
          })
        })
      )
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
    // Stop. Real approval signals flow through PermissionRequest.
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

  it('PermissionRequest maps to waiting and surfaces the pending tool input', () => {
    // Why: Codex asks for user attention through PermissionRequest. Orca's
    // sidebar red dot depends on this becoming `waiting`; treating it like
    // PreToolUse would leave the pane looking busy while it is blocked on the
    // user.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'exec_command',
        tool_input: { cmd: 'rm -rf build', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe('codex')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('rm -rf build')
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

describe('Droid hook normalization', () => {
  it('UserPromptSubmit maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'ship this fix' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('droid')
    expect(result?.payload.prompt).toBe('ship this fix')
  })

  it('Notification maps permission prompts to waiting and idle prompts to done', () => {
    const waiting = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid needs your permission to use Execute'
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )
    expect(done?.payload.state).toBe('done')

    const ignored = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Task completed successfully'
      }),
      'production'
    )
    expect(ignored).toBeNull()
  })

  it('Notification preserves the cached user prompt instead of using status text as prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )

    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('write tests')
  })

  it('Notification ignores confirmation status text rather than treating it as permission', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Confirmed configuration loaded'
      }),
      'production'
    )

    expect(result).toBeNull()
  })

  it('PreToolUse maps to working and surfaces the tool name and input preview', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/example.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/tmp/example.ts')
  })

  it('PreToolUse falls back to the `name` and `input` fields when tool_name/tool_input are absent', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        name: 'Bash',
        input: { command: 'pnpm typecheck' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('Bash')
    expect(result?.payload.toolInput).toBe('pnpm typecheck')
  })

  it('PreToolUse AskUser maps to waiting for human input', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUser',
        tool_input: { question: 'Which permission-requiring action should I perform?' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('AskUser')
  })

  it('PreToolUse high-risk Execute maps to waiting for approval', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: {
          command: 'echo "test modification" >> ~/.claude/config.json',
          riskLevel: 'high',
          riskLevelReason: "This command modifies the user's Claude Code config file."
        }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('Execute')
    expect(result?.payload.toolInput).toBe('echo "test modification" >> ~/.claude/config.json')
  })

  it('PermissionRequest maps low-impact Edit approvals to waiting and carries cached tool', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'edit it to none' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/Users/thebr/.claude/settings.json',
          old_str: '"preferredNotifChannel": "terminal_bell"',
          new_str: '"preferredNotifChannel": "none"'
        }
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.prompt).toBe('edit it to none')
    expect(result?.payload.toolName).toBe('Edit')
    expect(result?.payload.toolInput).toBe('/Users/thebr/.claude/settings.json')
  })

  it('SessionStart resets turn caches without marking Droid working', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'old prompt' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/old.ts' }
      }),
      'production'
    )

    const sessionStart = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(sessionStart).toBeNull()

    const nextTool = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: { command: 'pwd' }
      }),
      'production'
    )
    expect(nextTool?.payload.state).toBe('working')
    expect(nextTool?.payload.prompt).toBe('')
    expect(nextTool?.payload.toolName).toBe('Execute')
    expect(nextTool?.payload.toolInput).toBe('pwd')
  })

  it('SubagentStop does not close the primary session row', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'SubagentStop' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('Stop maps to done and preserves the cached prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )
    const stop = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('write tests')
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

  it('ingestRemote stamps connectionId and feeds the listener bypassing HTTP', () => {
    const server = new AgentHookServer()
    const events: { paneKey: string; connectionId: string | null; payload: unknown }[] = []
    server.setListener((evt) => {
      events.push({
        paneKey: evt.paneKey,
        connectionId: evt.connectionId,
        payload: evt.payload
      })
    })
    try {
      const remotePane = makePaneKey('tab-3', LEAF_3)
      server.ingestRemote(
        {
          paneKey: remotePane,
          tabId: 'tab-3',
          worktreeId: 'wt-3',
          payload: {
            state: 'working',
            prompt: 'remote prompt',
            agentType: 'claude'
          }
        },
        'conn-42'
      )
      expect(events).toHaveLength(1)
      expect(events[0].paneKey).toBe(remotePane)
      expect(events[0].connectionId).toBe('conn-42')
      expect(events[0].payload).toMatchObject({
        state: 'working',
        prompt: 'remote prompt',
        agentType: 'claude'
      })
    } finally {
      server.setListener(null)
    }
  })

  it('ingestRemote ignores malformed envelopes (fail-open)', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    try {
      // Missing paneKey
      server.ingestRemote({ paneKey: '', payload: { state: 'working' } } as never, 'conn-x')
      // Missing payload state
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { foo: 'bar' } }, 'conn-x')
      // Invalid payload state
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { state: 'nonsense' } }, 'conn-x')
      // Empty connection id
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { state: 'working' } }, '  ')
      // Wrong types
      server.ingestRemote(
        { paneKey: 'tab-1:0', payload: 'not-an-object' as unknown } as never,
        'conn-x'
      )
      expect(listener).not.toHaveBeenCalled()
    } finally {
      server.setListener(null)
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

describe('Last-status persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-laststatus-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  // Why: hydrate now drops entries older than 7d (HYDRATE_MAX_AGE_MS). Use
  // a recent-but-not-Date.now() timestamp in fixtures so the tests assert
  // hydration behavior rather than racing the wall clock.
  function recentTs(offsetMs = 0): number {
    return Date.now() - 60 * 60 * 1000 + offsetMs
  }

  async function postHookEvent(
    server: AgentHookServer,
    body: Body,
    path: string = '/hook/claude'
  ): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify(body)
    })
  }

  it('writes last-status.json after a hook event', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'persist me' })
      )
      // Synchronous flush via stop() captures the trailing-debounced write.
      server.flushStatusPersistSync()
      expect(existsSync(lastStatusPath())).toBe(true)
      const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(file.version).toBe(2)
      expect(file.entries[PANE]).toMatchObject({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        receivedAt: expect.any(Number),
        stateStartedAt: expect.any(Number),
        payload: expect.objectContaining({ state: 'working', prompt: 'persist me' })
      })
    } finally {
      server.stop()
    }
  })

  it('hydrates last-status.json into the cache before listener registration', async () => {
    // Pre-populate the file directly to simulate a prior session.
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    const stateStartedAt = recentTs(-1000)
    const fileContents = {
      version: 2,
      entries: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          receivedAt,
          stateStartedAt,
          payload: {
            state: 'done',
            prompt: 'survived restart',
            agentType: 'claude'
          }
        }
      }
    }
    writeFileSync(lastStatusPath(), JSON.stringify(fileContents), 'utf8')

    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          receivedAt,
          stateStartedAt,
          payload: expect.objectContaining({
            state: 'done',
            prompt: 'survived restart',
            agentType: 'claude'
          })
        })
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          receivedAt,
          stateStartedAt,
          state: 'done',
          prompt: 'survived restart',
          agentType: 'claude'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('treats a corrupt file as empty hydration without throwing', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(lastStatusPath(), 'not-json{{', 'utf8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      server.stop()
      warnSpy.mockRestore()
    }
  })

  it('rejects a stale version mismatch on hydrate', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 1,
        entries: {
          [PANE]: {
            paneKey: PANE,
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'old version', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('version mismatch'))
    } finally {
      server.stop()
      warnSpy.mockRestore()
    }
  })

  it('drops entries with malformed paneKeys but keeps valid ones', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          // Missing colon — drop.
          'no-colon': {
            paneKey: 'no-colon',
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'bad', agentType: 'claude' }
          },
          // Embedded paneKey mismatch — drop.
          [PANE]: {
            paneKey: makePaneKey('tab-x', LEAF_2),
            receivedAt: 1_700_000_000_000,
            stateStartedAt: 1_699_999_999_000,
            payload: { state: 'done', prompt: 'mismatch', agentType: 'claude' }
          },
          // Valid.
          [GOOD_PANE]: {
            paneKey: GOOD_PANE,
            tabId: 'tab-good',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'survived', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: GOOD_PANE,
          payload: expect.objectContaining({ prompt: 'survived' })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('drops hydrate entries older than the TTL cutoff', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          // Stale — should be dropped.
          [OLD_PANE]: {
            paneKey: OLD_PANE,
            tabId: 'tab-old',
            receivedAt: eightDaysAgoMs,
            stateStartedAt: eightDaysAgoMs - 1000,
            payload: { state: 'done', prompt: 'old', agentType: 'claude' }
          },
          // Recent — should survive.
          [FRESH_PANE]: {
            paneKey: FRESH_PANE,
            tabId: 'tab-fresh',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'fresh', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const snapshot = server.getStatusSnapshot()
      expect(snapshot.map((e) => e.paneKey)).toEqual([FRESH_PANE])
    } finally {
      server.stop()
    }
  })

  it('hydrates registered legacy numeric pane keys as stable pane status entries', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          'tab-1:0': {
            paneKey: 'tab-1:0',
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-1:0', PANE)
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          state: 'working',
          prompt: 'legacy cached',
          agentType: 'claude'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('clears hydrated stable statuses when their persisted legacy alias PTY is cleared', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          'tab-1:0': {
            paneKey: 'tab-1:0',
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    const statusListener = vi.fn()
    server.registerPaneKeyAlias('tab-1:0', PANE, 'pty-1')
    server.subscribeStatusChanges(statusListener)
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toHaveLength(1)

      server.clearPaneKeyAliasesForPty('pty-1')

      expect(server.getStatusSnapshot()).toEqual([])
      expect(statusListener).toHaveBeenCalledWith([])
    } finally {
      server.stop()
    }
  })

  it('does not clear a stable status when alias cleanup no longer owns that pane', () => {
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-1:0', PANE, 'old-pty')
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    server.clearPaneKeyAliasesForPty('old-pty', { shouldClearStablePaneKey: () => false })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        agentType: 'claude'
      })
    ])
  })

  it('drops a hydrate entry whose tabId disagrees with the paneKey prefix', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [TAB_A_PANE]: {
            paneKey: TAB_A_PANE,
            // Why: deliberately divergent — paneKey says tab-A, the entry
            // claims tab-B. Sanitizer must drop rather than hydrate this
            // inconsistent row.
            tabId: 'tab-B',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'mismatch', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('clearPaneState evicts the entry from the on-disk file', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'about to drop' })
      )
      server.flushStatusPersistSync()
      let parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(parsed.entries[PANE]).toBeTruthy()

      server.clearPaneState(PANE)
      server.flushStatusPersistSync()
      parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(parsed.entries[PANE]).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('skips a write when the serialized contents are byte-identical to the previous write', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'first' })
      )
      server.flushStatusPersistSync()
      const firstMtime = statSync(lastStatusPath()).mtimeMs

      // Why: a no-op clearPaneState on a paneKey not in the cache is a
      // mutation site that should NOT trigger a redundant write. (clear was
      // designed to bail when nothing was evicted.)
      server.clearPaneState(makePaneKey('non-existent', LEAF_5))
      server.flushStatusPersistSync()
      // Touch back to the same mtime would let the test pass spuriously, so
      // assert no rewrite happened by checking that mtime is unchanged after
      // a forced sync flush.
      const secondMtime = statSync(lastStatusPath()).mtimeMs
      expect(secondMtime).toBe(firstMtime)
    } finally {
      server.stop()
    }
  })

  it('stop() flushes pending debounced writes synchronously', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'flush me' })
      )
      // Note: do NOT call flushStatusPersistSync explicitly — let stop() do it.
    } finally {
      server.stop()
    }
    // Why: file written even though we never explicitly flushed before stop —
    // stop() must synchronously drain the pending trailing-debounced timer.
    expect(existsSync(lastStatusPath())).toBe(true)
    const parsed = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
    expect(parsed.entries[PANE]?.payload?.prompt).toBe('flush me')
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
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, 'conn-1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'conn-1',
        receivedAt: expect.any(Number),
        stateStartedAt: expect.any(Number),
        payload
      })
    )
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

  it('drops remote relay envelopes with legacy numeric paneKeys before cache mutation', () => {
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
      { paneKey: 'tab-1:0', tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('maps registered legacy numeric relay pane keys to stable pane keys', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.registerPaneKeyAlias('tab-1:0', PANE)
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: 'tab-1:0', tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'conn-1',
        payload
      })
    )
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        state: 'working',
        prompt: 'p'
      })
    ])
  })

  it('drops remote relay envelopes whose tabId disagrees with the paneKey tab', () => {
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
      { paneKey: PANE, tabId: 'tab-other', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
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
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, '')
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
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, '   ')
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
    server.ingestRemote({ paneKey: '   ', tabId: 'tab-1', worktreeId: 'wt-1', payload }, 'conn-1')
    expect(listener).not.toHaveBeenCalled()
    expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'empty_pane_key'
    })
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
