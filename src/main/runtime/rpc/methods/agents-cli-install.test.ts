import { describe, expect, it, vi } from 'vitest'
import { AGENTS_CLI_INSTALL_METHODS } from './agents-cli-install'

vi.mock('../../../tui-agent-cli-install-service', () => ({
  installTuiAgentClis: vi.fn(async (agents: string[]) => ({
    results: agents.map((agent) => ({ agent, status: 'installed' as const }))
  }))
}))

describe('agents.installCli RPC', () => {
  it('registers the install method', () => {
    expect(AGENTS_CLI_INSTALL_METHODS.map((method) => method.name)).toEqual(['agents.installCli'])
  })

  it('accepts allowlisted agents and rejects unknown ones', async () => {
    const method = AGENTS_CLI_INSTALL_METHODS[0]
    expect(method).toBeDefined()
    if (!method?.params) {
      throw new Error('expected params schema')
    }
    expect(method.params.safeParse({ agents: ['claude', 'codex'] }).success).toBe(true)
    expect(method.params.safeParse({ agents: ['not-real'] }).success).toBe(false)
    expect(method.params.safeParse({ agents: [], command: 'rm -rf /' }).success).toBe(false)
    expect(method.params.safeParse({ agents: ['claude'], command: 'echo hi' }).success).toBe(false)
  })
})
