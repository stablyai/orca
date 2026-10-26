import { describe, expect, it, vi } from 'vitest'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../shared/rpc-contract/agent-session-params'
import { HostAccountLaunchEnvParams } from '../../shared/host-account-launch-env'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

const ACCOUNT_ENV = {
  CLAUDE_CONFIG_DIR: '/home/u/.orca/claude-accounts/a/config',
  ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca/claude-accounts/a/config',
  CODEX_HOME: '/home/u/.orca/codex-b'
}

function operationId(): string {
  return `${Date.now()}-0123456789abcdef0123456789abcdef`
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
  const store = {
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: { codex: { KEEP: '1', CODEX_HOME: '/stale' } }
    })
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null
    }))
  })
  return runtime
}

/** Capture each host-planned create before spawning. */
function planCreates(runtime: OrcaRuntimeService) {
  const planned: TerminalCreateOptions[] = []
  const createTerminal = vi
    .spyOn(runtime, 'createTerminal')
    .mockImplementation(async (selector = '', opts = {}) => {
      const scope = await runtime.resolveTerminalWorkspaceLaunchScope(selector)
      planned.push(await runtime.resolveAgentTerminalCreateOptions(scope, opts))
      return terminal()
    })
  return { createTerminal, planned }
}

describe('agent-session creates with a desktop-prepared accountEnv', () => {
  it("lays it over a new agent's own launch env", async () => {
    const runtime = createRuntime()
    const { planned } = planCreates(runtime)
    await runtime.createAgentSession(
      CreateAgentSessionParams.parse({
        clientOperationId: operationId(),
        worktree: 'id:worktree-1',
        agent: 'codex',
        accountEnv: ACCOUNT_ENV
      })
    )
    expect(planned[0]?.env).toMatchObject({ KEEP: '1', ...ACCOUNT_ENV })
  })

  it('stays outside the replay fingerprint: a retry with another env replays, not conflicts', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()
    const base = { clientOperationId: id, worktree: 'id:worktree-1', agent: 'codex' as const }
    await runtime.createAgentSession({ ...base, accountEnv: ACCOUNT_ENV })
    await expect(runtime.createAgentSession(base)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('leaves the launch env as built when an older client sends none', async () => {
    const runtime = createRuntime()
    const { planned } = planCreates(runtime)
    await runtime.createAgentSession({
      clientOperationId: operationId(),
      worktree: 'id:worktree-1',
      agent: 'codex'
    })
    expect(planned[0]?.env).toMatchObject({ CODEX_HOME: '/stale' })
  })

  it('puts the host-selected account over Settings agent env', async () => {
    const runtime = createRuntime()
    runtime.setHostAccountLaunchEnv(
      HostAccountLaunchEnvParams.parse({
        wslDistro: 'Ubuntu',
        claude: {},
        terminal: { CODEX_HOME: ACCOUNT_ENV.CODEX_HOME }
      })
    )
    const { planned } = planCreates(runtime)
    await runtime.createAgentSession({
      clientOperationId: operationId(),
      worktree: 'id:worktree-1',
      agent: 'codex'
    })
    expect(planned[0]?.env).toMatchObject({ KEEP: '1', CODEX_HOME: ACCOUNT_ENV.CODEX_HOME })
  })

  it('carries it through a resumed (restored or sleeping) agent', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    await runtime.ensureAgentSession(
      EnsureAgentSessionParams.parse({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        spawnIntent: 'automatic-restore',
        accountEnv: ACCOUNT_ENV
      })
    )
    expect(createTerminal.mock.calls[0][1]?.env).toMatchObject({ KEEP: '1', ...ACCOUNT_ENV })
  })
})
