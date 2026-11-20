import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ wsl: false }))
// Nothing on PATH: only Orca's own copies can make an agent installed.
vi.mock('./agent-command-detection', () => ({ detectAgentCommandsOnHost: async () => new Set() }))
vi.mock('../ipc/preflight/preflight-runtime-target', () => ({
  getPreflightWslTarget: () => (host.wsl ? { distro: 'Ubuntu' } : null)
}))

const { detectInstalledAgents } = await import('./installed-agent-detection')
const { provideInstalledManagedAgents } = await import('./managed-agent-detection')

afterEach(() => {
  host.wsl = false
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
