import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DistroGateModule from '../wsl-background-distro-gate'

const mocks = vi.hoisted(() => {
  const state: { distro: 'running' | 'stopped' | 'unverifiable' } = { distro: 'stopped' }
  return { state }
})
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGateModule>()),
  readWslDistroRunningState: vi.fn(async () => mocks.state.distro)
}))

import { resolvePrStartPointUnlessWslStopped } from './pr-start-point-wsl-gate'

const WSL_REPO = { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }
const START_POINT = { baseBranch: 'origin/main' }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('PR start point for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.state.distro = 'stopped'
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('refuses a background push-target ensure without resolving', async () => {
    const resolve = vi.fn(async () => START_POINT)
    await expect(resolvePrStartPointUnlessWslStopped(WSL_REPO, {}, resolve)).resolves.toEqual({
      error: "WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a host path whose Git and gh run in the stopped distro', async () => {
    const resolve = vi.fn(async () => START_POINT)
    const result = await resolvePrStartPointUnlessWslStopped(
      { path: 'C:\\src\\repo', wslDistro: 'Ubuntu' },
      {},
      resolve
    )
    expect(result).toHaveProperty('error')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses when WSL cannot say the distro runs', async () => {
    mocks.state.distro = 'unverifiable'
    const resolve = vi.fn(async () => START_POINT)
    const result = await resolvePrStartPointUnlessWslStopped(WSL_REPO, {}, resolve)
    expect(result).toHaveProperty('error', expect.stringContaining("didn't answer"))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves for the user creating from the PR, which may start the distro', async () => {
    const resolve = vi.fn(async () => START_POINT)
    await expect(
      resolvePrStartPointUnlessWslStopped(WSL_REPO, { wakeWslDistro: true }, resolve)
    ).resolves.toEqual(START_POINT)
  })

  it('resolves host repos and running distros as before', async () => {
    const resolve = vi.fn(async () => START_POINT)
    await expect(
      resolvePrStartPointUnlessWslStopped({ path: 'C:\\src\\repo' }, {}, resolve)
    ).resolves.toEqual(START_POINT)
    mocks.state.distro = 'running'
    await expect(resolvePrStartPointUnlessWslStopped(WSL_REPO, {}, resolve)).resolves.toEqual(
      START_POINT
    )
  })
})
