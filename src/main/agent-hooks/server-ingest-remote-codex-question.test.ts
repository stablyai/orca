import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../shared/agent-hook-listener/listener-state'
import { buildRelayHookEnvelope } from '../../wsl-guest/agent-hook-envelope-build'
import { AgentHookServer, _internals } from './server'
import { PANE, buildBody } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const QUESTIONS = {
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which scope should I use?',
      options: [{ label: 'Current workspace', description: 'Update the current workspace.' }]
    }
  ]
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function remoteCodex() {
  const host = createHookListenerState()
  const server = new AgentHookServer()
  return {
    server,
    report(payload: Record<string, unknown>, legacy = false) {
      const event = normalizeHookPayload(
        host,
        'codex',
        buildBody(payload, { worktreeId: 'folder-workspace' }),
        'production'
      )
      if (!event) {
        throw new Error('Expected a Codex hook event')
      }
      seedLegacyAgentStatusForTests(host, event)
      const { mainAgent: _mainAgent, ...legacyPayload } = event.payload
      server.ingestRemote(
        buildRelayHookEnvelope(
          { ...event, payload: legacy ? legacyPayload : event.payload },
          'codex'
        ),
        'wsl:Ubuntu'
      )
      return server.getStatusSnapshotForPane(PANE)[0]
    }
  }
}

describe('remote Codex questions', () => {
  it.each([false, true])(
    'keeps a host question waiting until its answer (legacy relay: %s)',
    (legacy) => {
      const pane = remoteCodex()
      expect(
        pane.report(
          { hook_event_name: 'UserPromptSubmit', prompt: 'Update this workspace' },
          legacy
        )
      ).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      const question = pane.report(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'request_user_input',
          tool_input: QUESTIONS,
          tool_use_id: 'question-1'
        },
        legacy
      )
      expect(question).toMatchObject({
        state: 'waiting',
        mainAgent: { state: 'waiting' },
        toolName: 'request_user_input',
        interactivePrompt: JSON.stringify(QUESTIONS),
        connectionId: 'wsl:Ubuntu',
        worktreeId: 'folder-workspace'
      })

      expect(
        pane.report(
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'request_user_input',
            tool_input: QUESTIONS,
            tool_response: '{"answers":{"scope":{"answers":["Current workspace"]}}}',
            tool_use_id: 'question-1'
          },
          legacy
        )
      ).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(pane.server.getStatusSnapshotForPane(PANE)[0]?.interactivePrompt).toBeUndefined()

      expect(pane.report({ hook_event_name: 'Stop' }, legacy)).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done' }
      })
    }
  )

  it('does not mistake a waiting child for a root question on an ordinary tool call', () => {
    const pane = remoteCodex()
    pane.report({ hook_event_name: 'UserPromptSubmit', prompt: 'Run the checks' })
    pane.report({ hook_event_name: 'SubagentStart', agent_id: 'child' })
    pane.report({
      hook_event_name: 'PreToolUse',
      agent_id: 'child',
      tool_name: 'request_user_input',
      tool_input: QUESTIONS
    })

    expect(pane.report({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' })).toMatchObject(
      { state: 'waiting', mainAgent: { state: 'working' } }
    )
  })

  it('preserves ordinary approval waiting and resumes on tool execution', () => {
    const pane = remoteCodex()
    pane.report({ hook_event_name: 'UserPromptSubmit', prompt: 'Run the checks' })
    expect(
      pane.report({ hook_event_name: 'PermissionRequest', tool_name: 'exec_command' })
    ).toMatchObject({ state: 'waiting', mainAgent: { state: 'waiting' } })
    expect(pane.report({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' })).toMatchObject(
      { state: 'working', mainAgent: { state: 'working' } }
    )
  })
})
