import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  wsl: false,
  onPath: new Set<string>(),
  outsidePath: new Map<string, string>()
}))
// Nothing on PATH unless a case puts it there: only Orca's own copies can make an agent installed.
vi.mock('./agent-command-detection', () => ({
  detectAgentCommandsOnHost: async (
    _commands: readonly string[],
    options: { outsidePath?: Map<string, string> }
  ) => {
    host.outsidePath.forEach((path, command) => options.outsidePath?.set(command, path))
    return new Set([...host.onPath, ...host.outsidePath.keys()])
  }
}))
vi.mock('../ipc/preflight/preflight-runtime-target', () => ({
  getPreflightWslTarget: () => (host.wsl ? { distro: 'Ubuntu' } : null)
}))

const { detectInstalledAgentInventory, detectInstalledAgents } =
  await import('./installed-agent-detection')
const { provideInstalledManagedAgents } = await import('./managed-agent-detection')

afterEach(() => {
  host.wsl = false
  host.onPath = new Set()
  host.outsidePath = new Map()
  provideInstalledManagedAgents(async () => [])
})

it("counts Orca's installed copies as installed agents on this host", async () => {
  provideInstalledManagedAgents(async () => ['antigravity', 'grok'])

  expect((await detectInstalledAgents()).sort()).toEqual(['antigravity', 'grok'])
})

it('leaves out a disabled agent, and a WSL guest Orca installed nothing in', async () => {
  provideInstalledManagedAgents(async () => ['antigravity', 'grok'])

  expect(await detectInstalledAgents(undefined, { disabledTuiAgents: ['grok'] })).toEqual([
    'antigravity'
  ])
  host.wsl = true
  expect(await detectInstalledAgents()).toEqual([])
})

it("reports the full path to Orca's copy only where the user has no CLI of their own", async () => {
  provideInstalledManagedAgents(
    async () => ['claude', 'codex'],
    async (agent) => `/data/orca/${agent}/bin/${agent}`
  )
  host.onPath = new Set(['codex'])

  expect(await detectInstalledAgentInventory()).toEqual({
    agents: ['codex', 'claude'],
    managedAgentCommands: { claude: '/data/orca/claude/bin/claude' }
  })
  host.wsl = true
  expect((await detectInstalledAgentInventory()).managedAgentCommands).toBeUndefined()
})

it("runs the user's own CLI by full path when it was found only outside PATH", async () => {
  host.outsidePath = new Map([['claude', '/Users/a/.local/bin/claude']])

  expect(await detectInstalledAgentInventory()).toEqual({
    agents: ['claude'],
    managedAgentCommands: { claude: '/Users/a/.local/bin/claude' }
  })
  expect(
    (await detectInstalledAgentInventory(undefined, { agentCmdOverrides: { claude: 'my-claude' } }))
      .managedAgentCommands
  ).toEqual({})
})
