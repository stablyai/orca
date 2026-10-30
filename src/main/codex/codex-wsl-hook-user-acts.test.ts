import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  realpath: vi.fn(async (path: string) => path)
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  realpath: mocks.realpath
}))
vi.mock('./hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: mocks.prepare }
}))
vi.mock('./codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: vi.fn() }))
vi.mock('./codex-windows-sandbox-read-grant', () => ({
  grantCodexSandboxReadOnManagedHome: vi.fn()
}))
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultWslDistro: () => 'Ubuntu'
}))

import { isWslUserActFor } from '../wsl/wsl-user-act-scope'
import { prepareManagedWslCodexHomeBeforeShellLaunch } from './managed-wsl-home-shell-preflight'
import { createCodexRuntimeHomeLaunchPreparation } from './codex-runtime-home-launch-preparation'

const HOME = '/home/alice/.local/share/orca/codex-runtime-home/home'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  mocks.prepare.mockReset()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

// These install for a terminal the user is opening, so they may touch (and start) its distro (E9).
describe('Codex WSL hook installs that are user acts', () => {
  it('the guest shell preflight installs as a user act on its distro', async () => {
    const inAct: boolean[] = []
    await prepareManagedWslCodexHomeBeforeShellLaunch({
      env: { CODEX_HOME: HOME, ORCA_CODEX_HOME: HOME, WSL_DISTRO_NAME: 'Ubuntu' },
      hooksEnabled: true,
      install: async () => {
        inAct.push(isWslUserActFor('Ubuntu'), isWslUserActFor('Debian'))
        return null
      }
    })
    expect(inAct).toEqual([true, false])
  })

  it('a pane launch is not a user act: a passive restore reaches it too, so it must not start the distro', async () => {
    const inAct: boolean[] = []
    mocks.prepare.mockImplementation(async () => {
      inAct.push(isWslUserActFor('Ubuntu'))
      return {
        agent: 'codex',
        state: 'installed',
        configPath: '',
        managedHooksPresent: true,
        detail: null
      }
    })
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async () => '\\\\wsl.localhost\\Ubuntu\\home'
      }),
      getSettings: () => undefined
    })
    await prepare({ runtime: 'wsl', wslDistro: 'Ubuntu' }, undefined, {
      launchesCodex: true
    })
    expect(inAct).toEqual([false])
  })
})
