import { beforeEach, expect, it, vi } from 'vitest'
import { createUsageProviderAvailabilityResolver } from './usage-provider-availability'
import { notifyAgentsRefreshedOnHost } from '../preflight/agents-refreshed-on-host'
import { detectInstalledAgents } from '../preflight/installed-agent-detection'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'

vi.mock('../preflight/installed-agent-detection', () => ({ detectInstalledAgents: vi.fn() }))
vi.mock('../wsl/discovery/wsl-background-distro-gate', () => ({
  isWslDistroRunningForBackgroundWork: vi.fn()
}))
vi.mock('../node-runtime/managed-runtime-installation', () => ({
  managedRuntimeReleasesRevision: () => 0
}))
vi.mock('../startup/shell-environment/login-shell-environment', () => ({
  loginShellEnvironmentRevision: () => 0
}))
beforeEach(() => vi.resetAllMocks())

it.each([10, 100])(
  'shares one inventory across %s provider checks and refuses disabled or absent agents',
  async (count) => {
    let disabledTuiAgents: TuiAgent[] = ['kimi']
    const allowed = createUsageProviderAvailabilityResolver(() => ({
      disabledTuiAgents,
      agentCmdOverrides: {}
    }))
    const signal = new AbortController().signal
    vi.mocked(detectInstalledAgents).mockResolvedValue(['kimi'])
    expect(await allowed('kimi', signal)).toBe(false)
    expect(detectInstalledAgents).toHaveBeenCalledTimes(0)
    disabledTuiAgents = []
    const results = await Promise.all(Array.from({ length: count }, () => allowed('kimi', signal)))
    expect(results.every((result) => result === true)).toBe(true)
    expect(await allowed('grok', signal)).toBe(false)
    expect(detectInstalledAgents).toHaveBeenCalledTimes(1)
    for (let index = 0; index < count; index += 1) {
      expect(await allowed('kimi', new AbortController().signal)).toBe(true)
    }
    expect(detectInstalledAgents).toHaveBeenCalledTimes(1)
    disabledTuiAgents = ['kimi']
    expect(await allowed('kimi', signal)).toBe(false)
    vi.mocked(detectInstalledAgents).mockResolvedValue([])
    disabledTuiAgents = []
    notifyAgentsRefreshedOnHost(true)
    expect(await allowed('kimi', new AbortController().signal)).toBe(false)
  }
)

it('refuses a late inventory answer after the agent is disabled or the cycle is cancelled', async () => {
  let answer!: (agents: string[]) => void
  vi.mocked(detectInstalledAgents).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  let disabledTuiAgents: TuiAgent[] = []
  const allowed = createUsageProviderAvailabilityResolver(() => ({
    disabledTuiAgents,
    agentCmdOverrides: {}
  }))
  const controller = new AbortController()
  const pending = allowed('kimi', controller.signal)
  disabledTuiAgents = ['kimi']
  answer(['kimi'])
  expect(await pending).toBe(false)
  disabledTuiAgents = []
  controller.abort()
  expect(await allowed('kimi', controller.signal)).toBe(false)
})

it('keeps explicit plan accounts independent of CLI installs while honoring disabled agents', async () => {
  let disabledTuiAgents: TuiAgent[] = []
  const allowed = createUsageProviderAvailabilityResolver(() => ({
    disabledTuiAgents,
    agentCmdOverrides: {}
  }))
  const signal = new AbortController().signal
  expect(await allowed('zcode', signal, undefined, true)).toBe(true)
  disabledTuiAgents = ['zcode']
  expect(await allowed('zcode', signal, undefined, true)).toBe(false)
  expect(detectInstalledAgents).toHaveBeenCalledTimes(0)
})
