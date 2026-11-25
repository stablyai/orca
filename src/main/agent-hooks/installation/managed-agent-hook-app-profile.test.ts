import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The installers are spies, so no test can write an agent config, even with a broken gate.
const { profileRuntime, touched } = vi.hoisted(() => {
  const touched: string[] = []
  return { profileRuntime: vi.fn(() => true), touched }
})
vi.mock('../../app-profiles/app-profile', () => ({ isAppProfileRuntime: profileRuntime }))
vi.mock('./local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: async () => new Map()
}))
vi.mock('./managed-agent-hook-registry', () => {
  const entry = (agent: string, verb: string) =>
    [
      agent,
      async () => {
        touched.push(`${verb} ${agent}`)
        return { agent, state: 'installed', configPath: '', managedHooksPresent: true }
      }
    ] as const
  const agents = ['claude', 'grok']
  return {
    MANAGED_AGENT_HOOK_INSTALLERS: agents.map((agent) => entry(agent, 'install')),
    MANAGED_AGENT_HOOK_REMOVERS: agents.map((agent) => entry(agent, 'remove')),
    MANAGED_AGENT_HOOK_ASYNC_REMOVERS: agents.map((agent) => entry(agent, 'remove-async')),
    MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS: agents.map((agent) => entry(agent, 'refresh')),
    MANAGED_AGENT_HOOK_STATUS_READERS: []
  }
})

import {
  installManagedAgentHooks,
  removeManagedAgentHooks,
  removeManagedAgentHooksAsync
} from './managed-agent-hook-controls'

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-hook-gate-home-'))
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'ORCA_HOME_DIR']) {
    vi.stubEnv(key, home)
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('managed agent hooks in an app profile', () => {
  it('installs, refreshes and removes nothing: the hook commands use the .orca folder in HOME', async () => {
    const installed = await installManagedAgentHooks(null, { agents: ['claude', 'grok'] })
    expect(installed.map((status) => [status.agent, status.state])).toEqual([
      ['claude', 'skipped'],
      ['grok', 'skipped']
    ])
    expect(await removeManagedAgentHooks({ agents: ['claude'] })).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'skipped' })
    ])
    expect(await removeManagedAgentHooksAsync()).toHaveLength(2)
    expect(touched).toEqual([])
  })
})
