import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPaneCacheState,
  movePaneCacheState,
  producerCacheKey
} from '../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'
import { PANE, buildBody, postHookEvent } from './server.test-fixtures'

const CLAUDE_SESSION = '0f7f6c1e-1d0b-4c4e-9a52-6f1f7b0f3a11'
const CLAUDE_PROMPT_ID = '5b0e4a43-8d2b-4e43-a8b5-3c0e7f1d9b22'
const CODEX_SESSION = '019a2c4e-7b1d-7c3e-8f90-1a2b3c4d5e6f'

function claudeBody(dir: string, event: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: CLAUDE_SESSION,
    transcript_path: join(dir, `${CLAUDE_SESSION}.jsonl`),
    cwd: dir,
    prompt_id: CLAUDE_PROMPT_ID,
    permission_mode: 'default',
    ...event
  }
}

function codexBody(rollout: string, event: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    turn_id: 'turn-1',
    transcript_path: rollout,
    cwd: '/repo',
    model: 'gpt-6-astra',
    permission_mode: 'default',
    ...event
  }
}

describe('agents nested on one pane keep their own prompt and tool caches', () => {
  let dir: string
  let rollout: string
  let server: AgentHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nested-agent-producer-'))
    rollout = join(dir, 'rollout-codex.jsonl')
    writeFileSync(rollout, '')
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(path: string, payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload), path)
    expect(response.status).toBe(204)
  }

  async function claudeStartsCodexExec(): Promise<void> {
    await post(
      '/hook/claude',
      claudeBody(dir, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'claude: refactor the parser'
      })
    )
    // Claude runs `codex exec` through its Bash tool; Codex inherits the pane's hook address.
    await post(
      '/hook/claude',
      claudeBody(dir, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'codex exec "summarize the diff"' },
        tool_use_id: 'toolu_codex_exec'
      })
    )
  }

  async function runNestedCodexInsideClaude(): Promise<void> {
    await claudeStartsCodexExec()
    await post(
      '/hook/codex',
      codexBody(rollout, { hook_event_name: 'SessionStart', source: 'startup' })
    )
    await post(
      '/hook/codex',
      codexBody(rollout, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'codex: summarize the diff'
      })
    )
    await post(
      '/hook/codex',
      codexBody(rollout, {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'codex summary'
      })
    )
  }

  it("ends the Claude row on Claude's prompt after a nested Codex run", async () => {
    await runNestedCodexInsideClaude()

    await post(
      '/hook/claude',
      claudeBody(dir, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'codex exec "summarize the diff"' },
        tool_response: { stdout: 'codex summary', stderr: '', interrupted: false },
        tool_use_id: 'toolu_codex_exec'
      })
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      paneKey: PANE,
      state: 'working',
      prompt: 'claude: refactor the parser'
    })

    await post(
      '/hook/claude',
      claudeBody(dir, {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'parser refactored',
        background_tasks: [],
        session_crons: []
      })
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      paneKey: PANE,
      state: 'done',
      prompt: 'claude: refactor the parser',
      lastAssistantMessage: 'parser refactored'
    })
  })

  it("leaves Claude's caches untouched while the nested Codex reports", async () => {
    await claudeStartsCodexExec()
    const state = server._getStateForTests()
    const claudeKey = producerCacheKey(PANE, 'claude')
    const before = {
      prompt: state.lastPromptByProducerKey.get(claudeKey),
      tool: structuredClone(state.lastToolByProducerKey.get(claudeKey)),
      lead: structuredClone(state.claudeLeadStateByPaneKey.get(PANE)),
      sessionOwner: state.claudeSessionOwnerByPaneKey.get(PANE)
    }
    expect(before.prompt).toBe('claude: refactor the parser')

    for (const event of [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'codex: summarize the diff' },
      { hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'git diff' } },
      { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }
    ]) {
      await post('/hook/codex', codexBody(rollout, event))
    }

    expect({
      prompt: state.lastPromptByProducerKey.get(claudeKey),
      tool: state.lastToolByProducerKey.get(claudeKey),
      lead: state.claudeLeadStateByPaneKey.get(PANE),
      sessionOwner: state.claudeSessionOwnerByPaneKey.get(PANE)
    }).toEqual(before)
  })

  it('moves and clears every producer entry with the pane', async () => {
    await runNestedCodexInsideClaude()
    const state = server._getStateForTests()
    const moved = makePaneKey('tab-1', '99999999-9999-4999-8999-999999999999')
    const producerKeys = (paneKey: string): string[] =>
      [...state.lastPromptByProducerKey.keys(), ...state.lastToolByProducerKey.keys()].filter(
        (key) => key === paneKey || key.startsWith(`${paneKey}\0`)
      )
    expect(new Set(producerKeys(PANE))).toEqual(
      new Set([producerCacheKey(PANE, 'claude'), producerCacheKey(PANE, 'codex')])
    )

    movePaneCacheState(state, PANE, moved)
    expect(producerKeys(PANE)).toEqual([])
    expect(state.lastPromptByProducerKey.get(producerCacheKey(moved, 'claude'))).toBe(
      'claude: refactor the parser'
    )
    expect(state.lastPromptByProducerKey.get(producerCacheKey(moved, 'codex'))).toBe(
      'codex: summarize the diff'
    )

    clearPaneCacheState(state, moved)
    expect(producerKeys(moved)).toEqual([])
  })

  it('drops every producer entry when the tab closes', async () => {
    await runNestedCodexInsideClaude()
    const state = server._getStateForTests()

    server.dropStatusEntriesByTabPrefix('tab-1')

    expect([...state.lastPromptByProducerKey.keys()]).toEqual([])
    expect([...state.lastToolByProducerKey.keys()]).toEqual([])
  })
})
