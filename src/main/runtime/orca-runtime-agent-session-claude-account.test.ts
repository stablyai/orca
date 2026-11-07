import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

function operationId(): string {
  return `${Date.now()}-0123456789abcdef0123456789abcdef`
}

function request(
  clientOperationId: string,
  overrides: Partial<RuntimeCreateAgentSessionRequest> = {}
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'codex',
    prompt: 'do the thing',
    presentation: 'background',
    ...overrides
  }
}

function terminal() {
  return {
    handle: 'term_operation',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-operation',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime() {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this operation fixture supplies only getSettings; terminal scope is installed below.
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never
  )
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null
    }))
  })
  return runtime
}

describe('agent session operations with a Claude account', () => {
  it('refuses a changed Claude account under the same create operation', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()
    await runtime.createAgentSession(request(id, { agent: 'claude', claudeAccountId: 'acct-1' }))
    await expect(
      runtime.createAgentSession(request(id, { agent: 'claude', claudeAccountId: 'acct-2' }))
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('keeps a Claude account off a non-Claude launch config on create and resume', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    await runtime.createAgentSession(request(operationId(), { claudeAccountId: 'acct-1' }))
    await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-session-1' },
      claudeAccountId: 'acct-1'
    })
    expect(createTerminal).toHaveBeenCalledTimes(2)
    for (const call of createTerminal.mock.calls) {
      expect(call[1]?.launchConfig?.claudeAccountId).toBeUndefined()
      expect(call[1]?.launchClaudeAccountId).toBeUndefined()
    }
  })
})
