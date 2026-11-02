import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import {
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../shared/agent-status-types'
import type { AgentHookSource } from '../../shared/agent-hook-relay'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

afterEach(() => vi.restoreAllMocks())

describe('nested agent hooks preserve the owning pane', () => {
  it.each(['local', 'relay'] as const)(
    'keeps Claude children, prompt and turn stable through Codex review hooks over %s',
    async (transport) => {
      const server = new AgentHookServer()
      const dir = mkdtempSync(join(tmpdir(), 'orca-nested-roster-'))
      const relay = new RelayAgentHookServer({
        endpointDir: dir,
        forward: (event) => server.ingestRemote(event, 'conn-1')
      })
      const pushed = vi.fn()
      server.setListener(pushed)
      await server.start({ env: 'production' })
      try {
        if (transport === 'relay') {
          await relay.start()
        }
        const post = async (source: AgentHookSource, payload: Record<string, unknown>) => {
          const body = buildBody(payload)
          const response =
            transport === 'local'
              ? await postHookEvent(server, body, `/hook/${source}`)
              : await fetch(`http://127.0.0.1:${relay.getCoordinates().port}/hook/${source}`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Orca-Agent-Hook-Token': relay.getCoordinates().token
                  },
                  body: JSON.stringify(body)
                })
          expect(response.status).toBe(204)
        }
        await post('claude', {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'claude-parent',
          prompt: 'Fix SSH'
        })
        await post('claude', {
          hook_event_name: 'Stop',
          session_id: 'claude-parent',
          background_tasks: Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS }, (_, i) => ({
            id: `child${i}`,
            type: 'subagent',
            status: 'running',
            description: `Fix issue ${i}`
          }))
        })
        const before = server.getStatusSnapshot()
        expect(before[0]).toMatchObject({
          state: 'working',
          prompt: 'Fix SSH',
          mainAgent: { state: 'done' },
          providerSession: { id: 'claude-parent' }
        })
        expect(before[0]?.subagents).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
        pushed.mockClear()
        for (const hook_event_name of [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PermissionRequest',
          'Stop'
        ]) {
          await post('codex', {
            hook_event_name,
            session_id: 'codex-review',
            prompt: 'Review origin/main',
            tool_name: 'shell',
            tool_input: { command: 'git diff' },
            model: 'gpt-6-astra'
          })
          expect(server.getStatusSnapshot()).toEqual(before)
        }
        expect(pushed).not.toHaveBeenCalled()
        await post('claude', {
          hook_event_name: 'PreToolUse',
          session_id: 'claude-parent',
          agent_id: 'child0',
          tool_name: 'Read',
          tool_input: { file_path: 'README.md' }
        })
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          prompt: 'Fix SSH',
          mainAgent: { state: 'done' },
          providerSession: { id: 'claude-parent' },
          subagents: before[0]?.subagents
        })
        await post('claude', {
          hook_event_name: 'SubagentStop',
          session_id: 'claude-parent',
          agent_id: 'child0'
        })
        expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(
          AGENT_STATUS_MAX_SUBAGENTS - 1
        )
        await post('claude', {
          hook_event_name: 'Stop',
          session_id: 'claude-parent',
          background_tasks: []
        })
        expect(server.getStatusSnapshot()[0]?.state).toBe('done')
        await post('codex', {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'new-codex',
          prompt: 'New turn'
        })
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          agentType: 'codex',
          prompt: 'New turn',
          providerSession: { id: 'new-codex' }
        })
      } finally {
        relay.stop()
        server.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('allows a different provider after the previous status becomes stale', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'old-claude',
          prompt: 'Old turn'
        })
      )
      now.mockReturnValue(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'new-codex',
          prompt: 'New turn'
        }),
        '/hook/codex'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'codex',
        prompt: 'New turn',
        providerSession: { id: 'new-codex' }
      })
    } finally {
      server.stop()
    }
  })

  it('rejects a nested working snapshot from an older relay without renewing the parent', () => {
    const server = new AgentHookServer()
    const route = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'folder:workspace' }
    server.ingestRemote(
      {
        ...route,
        payload: {
          state: 'working',
          prompt: 'Fix SSH',
          agentType: 'claude',
          subagents: [{ id: 'child', state: 'working', startedAt: Date.now() }],
          mainAgent: { state: 'done', stateStartedAt: Date.now() }
        }
      },
      'conn-1'
    )
    const before = server.getStatusSnapshot()
    const pushed = vi.fn()
    server.setListener(pushed)
    pushed.mockClear()
    server.ingestRemote(
      {
        ...route,
        payload: {
          state: 'working',
          prompt: 'Review origin/main',
          agentType: 'codex'
        }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()).toEqual(before)
    expect(pushed).not.toHaveBeenCalled()
    server.stop()
  })
})
