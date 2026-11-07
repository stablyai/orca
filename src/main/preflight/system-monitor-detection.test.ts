import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const { hydrateShellPathMock, detectCommandsMock, wslTargetMock } = vi.hoisted(() => ({
  hydrateShellPathMock: vi.fn(async () => undefined),
  detectCommandsMock: vi.fn<(...args: unknown[]) => Promise<Set<string>>>(),
  wslTargetMock: vi.fn<(...args: unknown[]) => { distro: string } | null>(() => null)
}))

vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: hydrateShellPathMock
}))

vi.mock('./agent-command-detection', () => ({
  detectAgentCommandsOnHost: detectCommandsMock
}))

vi.mock('../ipc/preflight-runtime-target', () => ({
  getPreflightWslTarget: wslTargetMock
}))

import { detectSystemMonitorsOnHost } from './system-monitor-detection'

describe('detectSystemMonitorsOnHost', () => {
  beforeEach(() => {
    hydrateShellPathMock.mockClear()
    detectCommandsMock.mockReset()
    wslTargetMock.mockReset().mockReturnValue(null)
  })

  it('refuses legacy SSH hosts with SshHostNotServedError', async () => {
    await expect(
      detectSystemMonitorsOnHost({ kind: 'ssh', connectionId: 'ssh-prod' })
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    expect(hydrateShellPathMock).not.toHaveBeenCalled()
    expect(detectCommandsMock).not.toHaveBeenCalled()
  })

  it('hydrates shell PATH and resolves installed system and Docker monitors on local hosts', async () => {
    detectCommandsMock.mockResolvedValueOnce(
      new Set(['btop', 'htop', 'lazydocker', 'ctop', 'docker', 'ncdu', 'duf'])
    )

    const context = { wslDistro: 'Ubuntu' }
    wslTargetMock.mockReturnValue({ distro: 'Ubuntu' })

    const ids = await detectSystemMonitorsOnHost({ kind: 'local', context })
    expect(hydrateShellPathMock).toHaveBeenCalledWith(context)
    expect(detectCommandsMock).toHaveBeenCalledOnce()
    expect(ids).toEqual(['btop', 'htop', 'lazydocker', 'ctop', 'docker-stats', 'ncdu', 'duf'])
  })
})
