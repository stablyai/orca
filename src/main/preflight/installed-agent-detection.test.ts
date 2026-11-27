import { afterEach, expect, it, vi } from 'vitest'
import { detectAgentCommandInventoryOnHost } from './agent-command-detection'
import { detectInstalledAgents } from './installed-agent-detection'

vi.mock('./agent-command-detection', () => ({
  detectAgentCommandInventoryOnHost: vi.fn(async () => ({
    found: new Set(['claude', 'codex', 'gemini'])
  }))
}))

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.mocked(detectAgentCommandInventoryOnHost).mockClear()
})

const probed = () => vi.mocked(detectAgentCommandInventoryOnHost).mock.calls[0]?.[0]

it("checks one agent by probing only that agent's commands", async () => {
  await expect(detectInstalledAgents(undefined, { onlyTuiAgent: 'codex' })).resolves.toEqual([
    'codex'
  ])
  expect(probed()).toEqual(['codex'])
})

it("checks one agent in a WSL project by probing only that agent's commands in the guest", async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(detectAgentCommandInventoryOnHost).mockResolvedValueOnce({
    found: new Set(['claude']),
    incomplete: true
  })
  await expect(
    detectInstalledAgents({ wslDistro: 'Ubuntu' }, { onlyTuiAgent: 'claude' })
  ).resolves.toEqual(['claude'])
  expect(probed()).toEqual(['claude'])
  expect(vi.mocked(detectAgentCommandInventoryOnHost).mock.calls[0]?.[1]).toEqual({
    context: { wslDistro: 'Ubuntu' },
    onlyRequested: true,
    waitForCompletion: true
  })
})
