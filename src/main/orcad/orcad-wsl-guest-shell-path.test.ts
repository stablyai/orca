// wsl.exe --exec skips shell setup; hydrate login PATH to find Linux CLIs instead of Windows shims.
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
