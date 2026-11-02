import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { WslSkillInstallFilesystem } from './skill-wsl-install-filesystem'

const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.agents\\skills'

beforeEach(() => {
  runWslProcessMock.mockReset().mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false
  })
})

describe('WslSkillInstallFilesystem', () => {
  it('maps Windows workspace roots into the selected distro and rejects escapes', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [
      'C:\\Users\\jin\\repo\\.agents\\skills'
    ])
    await filesystem.rename(
      'C:\\Users\\jin\\repo\\.agents\\skills\\.skill.orca-staging-1',
      'C:\\Users\\jin\\repo\\.agents\\skills\\skill'
    )
    expect(runWslProcessMock.mock.calls[0]?.[0].args).toEqual(
      expect.arrayContaining([
        '/mnt/c/Users/jin/repo/.agents/skills/.skill.orca-staging-1',
        '/mnt/c/Users/jin/repo/.agents/skills/skill'
      ])
    )
    await expect(filesystem.remove('C:\\Users\\jin\\repo\\unrelated')).rejects.toThrow(
      'skill-install-wsl-path-outside-root'
    )
    expect(runWslProcessMock).toHaveBeenCalledOnce()
  })

  it('rejects a path from another distro before spawning wsl.exe', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    await expect(
      filesystem.remove('\\\\wsl.localhost\\Debian\\home\\jin\\.agents\\skills\\skill')
    ).rejects.toThrow('skill-install-wsl-path-invalid')
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })
})
