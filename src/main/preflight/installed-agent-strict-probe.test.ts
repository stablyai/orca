import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('detectInstalledAgents strict probe failures', () => {
  beforeEach(() => {
    detectCommandsMock.mockReset()
  })

  it('preserves strict probe failures while filtering disabled agents', async () => {
    const error = Object.assign(new Error('WSL unavailable'), {
      code: 'remote_runtime_unavailable'
    })
    detectCommandsMock.mockRejectedValueOnce(error)
    await expect(
      detectInstalledAgents(undefined, {
        disabledTuiAgents: ['codex'],
        failOnProbeError: true
      })
    ).rejects.toBe(error)
    expect(detectCommandsMock).toHaveBeenLastCalledWith(expect.not.arrayContaining(['codex']), {
      context: undefined,
      failOnProbeError: true
    })
  })
})
