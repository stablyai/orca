import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type InstalledDeps = {
  resolveLaunchArgs: (provider: 'claude' | 'codex') => Promise<string[]> | string[]
  resolveLaunchEnvOverlay: () => Record<string, string>
  resolveClaudeLaunchEnv?: () => Record<string, string>
}

const { installStructuredAgentSessionHost } = vi.hoisted(() => ({
  installStructuredAgentSessionHost: vi.fn(async (_deps: unknown) => ({}) as never)
}))

vi.mock('./structured-agent-session-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureStructuredAgentSessionHost: installStructuredAgentSessionHost
}))

function runtimeWith(settings: Record<string, unknown>): OrcaRuntimeService {
  return new OrcaRuntimeService({ getSettings: () => settings } as never)
}

async function installedDeps(settings: Record<string, unknown>): Promise<InstalledDeps> {
  installStructuredAgentSessionHost.mockClear()
  await runtimeWith(settings).ensureStructuredAgentSessionHost()
  return installStructuredAgentSessionHost.mock.calls[0]?.[0] as InstalledDeps
}

describe('structured agent-session launch args wiring', () => {
  it('resolves Claude launch args from the Claude agent defaults, not Codex flags', async () => {
    const deps = await installedDeps({
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions --model opus',
        codex: '--dangerously-bypass-approvals-and-sandbox'
      },
      agentDefaultEnv: {}
    })

    expect(await deps.resolveLaunchArgs('claude')).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus'
    ])
  })

  it('still resolves Codex app-server args for a Codex session', async () => {
    const deps = await installedDeps({
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--dangerously-bypass-approvals-and-sandbox'
      },
      agentDefaultEnv: {}
    })

    const codexArgs = await deps.resolveLaunchArgs('codex')
    expect(codexArgs).not.toContain('--dangerously-skip-permissions')
    expect(codexArgs.length).toBeGreaterThan(0)
  })

  it('never lets a broken Codex args configuration block a Claude session', async () => {
    const deps = await installedDeps({
      agentDefaultArgs: { claude: '--model opus', codex: '--not-a-real-codex-flag' },
      agentDefaultEnv: {}
    })

    expect(await deps.resolveLaunchArgs('claude')).toEqual(['--model', 'opus'])
    expect(() => deps.resolveLaunchArgs('codex')).toThrow()
  })

  it('supplies the Claude env overlay so the launch resolver does not fall back to process.env', async () => {
    const deps = await installedDeps({
      agentDefaultArgs: {},
      agentDefaultEnv: {
        claude: { ORCA_CLAUDE_OVERLAY: 'claude-value' },
        codex: { ORCA_CODEX_OVERLAY: 'codex-value' }
      }
    })

    expect(deps.resolveClaudeLaunchEnv).toBeTypeOf('function')
    expect(deps.resolveClaudeLaunchEnv?.()).toMatchObject({
      ORCA_CLAUDE_OVERLAY: 'claude-value'
    })
    expect(deps.resolveClaudeLaunchEnv?.()).not.toHaveProperty('ORCA_CODEX_OVERLAY')
    expect(deps.resolveLaunchEnvOverlay()).toMatchObject({ ORCA_CODEX_OVERLAY: 'codex-value' })
  })
})
