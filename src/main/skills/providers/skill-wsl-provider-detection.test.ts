import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'

describe('detectSkillProvidersInWsl', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects when wsl.exe cannot be started', async () => {
    runWslProcessMock.mockRejectedValue(new Error('spawn wsl.exe ENOENT'))

    await expect(detectSkillProvidersInWsl('Ubuntu')).rejects.toThrow(
      'skill-install-wsl-provider-detection-failed'
    )
  })

  it('rejects on a non-zero exit', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })

    await expect(detectSkillProvidersInWsl('Ubuntu')).rejects.toThrow(
      'skill-install-wsl-provider-detection-failed'
    )
  })
})
