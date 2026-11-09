import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as posixPwsh from '../../pty/shell-startup/posix-pwsh'

const { resolvePosixPaneShellPath } = vi.hoisted(() => ({
  resolvePosixPaneShellPath:
    vi.fn<(shellPath: string, spawnPathValue?: string) => Promise<string>>()
}))

vi.mock('../../pty/shell-startup/posix-pwsh', async (importOriginal) => ({
  ...(await importOriginal<typeof posixPwsh>()),
  resolvePosixPaneShellPath
}))

vi.mock('./local-pty-executable-spawn', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn()
}))

import { createLocalPtyLaunchPlan, DeferredLocalPtyLaunchPlan } from './local-pty-launch-plan'

describe('local POSIX pwsh launch plan', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    resolvePosixPaneShellPath.mockReset()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('defers a bare pwsh until its install path resolves', async () => {
    resolvePosixPaneShellPath.mockResolvedValue('/opt/microsoft/powershell/7/pwsh')
    const spawn = { cwd: '/tmp', cols: 80, rows: 24, shellOverride: 'pwsh', env: { PATH: '/bin' } }

    const plan = createLocalPtyLaunchPlan(spawn, () => ({}))

    expect(plan).toBeInstanceOf(DeferredLocalPtyLaunchPlan)
    if (!(plan instanceof DeferredLocalPtyLaunchPlan)) {
      throw new Error('Expected a deferred launch plan')
    }
    const finish = await plan.settle()
    expect(finish().shellPath).toBe('/opt/microsoft/powershell/7/pwsh')
    expect(resolvePosixPaneShellPath).toHaveBeenCalledWith('pwsh', '/bin')
  })

  it('plans other shells synchronously without resolving', () => {
    const spawn = { cwd: '/tmp', cols: 80, rows: 24, shellOverride: '/bin/zsh' }

    const plan = createLocalPtyLaunchPlan(spawn, () => ({}))

    expect(plan).not.toBeInstanceOf(DeferredLocalPtyLaunchPlan)
    expect('shellPath' in plan && plan.shellPath).toBe('/bin/zsh')
    expect(resolvePosixPaneShellPath).not.toHaveBeenCalled()
  })
})
