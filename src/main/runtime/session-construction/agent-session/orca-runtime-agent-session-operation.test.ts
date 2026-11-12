import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../../../shared/agent-session/agent-session-host-authority'
import { OrcaRuntimeService } from '../../orca-runtime'

import type { IPtyProvider } from '../../../providers/pty-provider-contract'

function operationId(now = Date.now(), nonce = '0123456789abcdef0123456789abcdef'): string {
  return `${now}-${nonce}`
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

function createRuntime(
  provider?: Pick<
    IPtyProvider,
    'supportsAgentSessionClaims' | 'supportsAgentSessionCreateOperations'
  >,
  settings: Record<string, unknown> = {}
) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this operation fixture supplies only getSettings; terminal scope and PTY dependencies are installed below.
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        ...settings
      })
    } as never,
    undefined,
    provider ? { getLocalProvider: () => provider as never } : undefined
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  return runtime
}

describe('agent-session create operation ledger', () => {
  it('joins concurrent retries and conflicts on a changed fingerprint', async () => {
    const runtime = createRuntime()
    let finish!: (result: ReturnType<typeof terminal>) => void
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const id = operationId()
    const first = runtime.createAgentSession(request(id), { clientId: 'device-a' })
    const joined = runtime.createAgentSession(request(id), { clientId: 'device-a' })

    await expect(
      runtime.createAgentSession(request(id, { prompt: 'changed' }), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_conflict')
    await expect(
      runtime.createAgentSession(request(id, { agentArgs: '--profile changed' }), {
        clientId: 'device-a'
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    finish(terminal())
    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(joined).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})

it('replays an effort-clear create after defaults change and conflicts if the clear changes', async () => {
  const settings = { agentLaunchChoices: { antigravity: { options: { effort: 'low' } } } }
  const runtime = createRuntime(undefined, settings)
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
  const id = operationId()
  const input = request(id, { agent: 'antigravity', terminalOptionEdits: { effort: null } })
  await expect(runtime.createAgentSession(input)).resolves.toMatchObject({ disposition: 'created' })
  expect(createTerminal.mock.lastCall?.[1]).toMatchObject({ terminalOptionEdits: { effort: null } })
  settings.agentLaunchChoices.antigravity.options.effort = 'high'
  await expect(runtime.createAgentSession(input)).resolves.toMatchObject({
    disposition: 'replayed'
  })
  await expect(
    runtime.createAgentSession({ ...input, terminalOptionEdits: undefined })
  ).rejects.toThrow('agent_session_operation_conflict')
  expect(createTerminal).toHaveBeenCalledOnce()
})
