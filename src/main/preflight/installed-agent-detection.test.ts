import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { detectCommandsMock } = vi.hoisted(() => ({
  detectCommandsMock: vi.fn(async (_commands: readonly string[]) => new Set<string>())
}))

vi.mock('./agent-command-detection', () => ({
  detectAgentCommandsOnHost: detectCommandsMock
}))
vi.mock('../ipc/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn(async () => undefined)
}))
vi.mock('../ipc/preflight-runtime-target', () => ({
  getPreflightWslTarget: vi.fn(() => null)
}))

import { detectInstalledAgents } from './installed-agent-detection'

const originalPlatform = process.platform

describe('detectInstalledAgents disabled-agent filtering', () => {
  beforeEach(() => {
    detectCommandsMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('omits a disabled agent with a unique command from probes and results', async () => {
    detectCommandsMock.mockImplementation(
      async (commands) =>
        new Set(commands.filter((command) => command === 'codex' || command === 'gemini'))
    )

    await expect(detectInstalledAgents()).resolves.toEqual(['codex', 'gemini'])
    await expect(
      detectInstalledAgents(undefined, { disabledTuiAgents: ['codex'] })
    ).resolves.toEqual(['gemini'])
    expect(detectCommandsMock).toHaveBeenLastCalledWith(expect.not.arrayContaining(['codex']), {
      context: undefined
    })
  })

  it('keeps a shared command for an enabled agent without reporting the disabled agent', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    detectCommandsMock.mockImplementation(
      async (commands) =>
        new Set(commands.filter((command) => command === 'claude' || command === 'orca'))
    )

    await expect(
      detectInstalledAgents(undefined, { disabledTuiAgents: ['claude'] })
    ).resolves.toEqual(['claude-agent-teams'])
    expect(detectCommandsMock).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(['claude', 'orca']),
      { context: undefined }
    )

    await expect(
      detectInstalledAgents(undefined, { disabledTuiAgents: ['claude-agent-teams'] })
    ).resolves.toEqual(['claude'])
    expect(detectCommandsMock).toHaveBeenLastCalledWith(expect.not.arrayContaining(['orca']), {
      context: undefined
    })
  })
})
