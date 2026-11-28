import { afterEach, expect, it, vi } from 'vitest'
import { detectAgentCommandsOnHost } from './agent-command-detection'
import { detectInstalledAgents } from './installed-agent-detection'

vi.mock('./agent-command-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['claude', 'codex', 'gemini']))
}))
vi.mock('./managed-agent-detection', () => ({
  readInstalledManagedAgents: vi.fn(async () => [])
}))

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.mocked(detectAgentCommandsOnHost).mockClear()
})

const probed = () => vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[0]

it("checks one agent by probing only that agent's commands", async () => {
  await expect(detectInstalledAgents(undefined, { onlyTuiAgent: 'codex' })).resolves.toEqual([
    'codex'
  ])
  expect(probed()).toEqual(['codex'])
})

it("checks one agent in a WSL project by probing only that agent's commands in the guest", async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await expect(
    detectInstalledAgents({ wslDistro: 'Ubuntu' }, { onlyTuiAgent: 'claude' })
  ).resolves.toEqual(['claude'])
  expect(probed()).toEqual(['claude'])
  expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toEqual({
    context: { wslDistro: 'Ubuntu' }
  })
})
