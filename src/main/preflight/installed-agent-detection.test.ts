import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ZcodeCliInvocation from '../zcode/zcode-cli-invocation'

const { detectCommandsMock } = vi.hoisted(() => ({
  detectCommandsMock: vi.fn(async (_commands: readonly string[]) => new Set<string>())
}))
const resolveZcodeInvocationMock = vi.hoisted(() => vi.fn())

vi.mock('./agent-command-detection', () => ({
  detectAgentCommandsOnHost: detectCommandsMock
}))
vi.mock('../ipc/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn(async () => undefined)
}))
vi.mock('../ipc/preflight-runtime-target', () => ({
  getPreflightWslTarget: vi.fn(() => null)
}))
vi.mock('../zcode/zcode-cli-invocation', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeCliInvocation>()),
  resolveZcodeCliInvocation: resolveZcodeInvocationMock
}))

import { detectInstalledAgents } from './installed-agent-detection'

const originalPlatform = process.platform

describe('detectInstalledAgents disabled-agent filtering', () => {
  beforeEach(() => {
    detectCommandsMock.mockReset()
    resolveZcodeInvocationMock.mockReset()
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

  it('removes a Desktop-only ZCode bundle from terminal inventory', async () => {
    detectCommandsMock.mockImplementation(
      async (commands) => new Set(commands.filter((command) => command === 'zcode'))
    )
    resolveZcodeInvocationMock.mockReturnValue({
      command: '/opt/ZCode/zcode',
      prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
      envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
      identity: 'desktop',
      source: 'desktop-bundle'
    })

    await expect(detectInstalledAgents()).resolves.toEqual([])
    expect(resolveZcodeInvocationMock).toHaveBeenCalledOnce()
  })
})
