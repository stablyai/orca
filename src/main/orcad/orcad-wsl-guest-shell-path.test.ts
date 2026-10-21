/**
 * orcad on a WSL host is launched by `wsl.exe --exec`, whose PATH misses Linux CLIs installed by
 * the login shell's rc files (claude, opencode, gemini) and carries Windows shims. Its agent
 * detection must hydrate PATH from `$SHELL -ilc` like any packaged build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hydration = vi.hoisted(() => ({
  hydrateShellPath: vi.fn(async () => ({ ok: true as const, segments: ['/home/u/.local/bin'] })),
  mergePathSegments: vi.fn(() => [])
}))
vi.mock('../startup/hydrate-shell-path', () => hydration)

import { getAppEnvironment } from '../../shared/app-environment'
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import { installOrcadHostAdapters } from './orcad-host-adapters'

describe('orcad PATH hydration on a WSL guest', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.clearAllMocks()
  })

  it('reports itself packaged, which is what gates the login-shell probe', () => {
    installOrcadHostAdapters()
    expect(getAppEnvironment().isPackaged()).toBe(true)
  })

  it('hydrates for detection even when a client names a WSL distro: inside it, Linux is local', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await hydrateShellPathForAgentDetection({ wslDistro: 'Ubuntu' })
    expect(hydration.hydrateShellPath).toHaveBeenCalledTimes(1)
    expect(hydration.mergePathSegments).toHaveBeenCalledWith(['/home/u/.local/bin'])
  })
})
