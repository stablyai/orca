import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  createWslSkillInstallFilesystem,
  WslSkillInstallFilesystem
} from './skill-wsl-install-filesystem'

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
  it('allows every global provider destination inside the selected distro', async () => {
    const home = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin'
    const filesystem = createWslSkillInstallFilesystem({
      distro: 'Ubuntu-24.04',
      homeDirectory: home
    })

    for (const directory of [
      '.claude',
      '.cursor',
      '.gemini',
      '.factory',
      '.continue',
      '.trae-cn',
      '.grok',
      '.augment'
    ]) {
      await filesystem.createAlias(
        `${home}\\.agents\\skills\\private-skill`,
        `${home}\\${directory}\\skills\\private-skill`
      )
    }

    expect(runWslProcessMock).toHaveBeenCalledTimes(8)
  })

  it('applies and verifies manifest modes through bounded guest argv batches', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    const manifest = {
      files: [
        { path: 'SKILL.md', executable: false },
        { path: 'scripts/run.sh', executable: true }
      ]
    } as SkillPackageManifestV1
    await filesystem.prepareExtractedSkill(`${WSL_ROOT}\\.orca-skill-extract-1\\skill`, manifest)

    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    const calls = runWslProcessMock.mock.calls.map(([spec]) => spec.args as string[])
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '600',
        '/home/jin/.agents/skills/.orca-skill-extract-1/skill/SKILL.md',
        '700',
        '/home/jin/.agents/skills/.orca-skill-extract-1/skill/scripts/run.sh'
      ])
    )
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        '600',
        '/home/jin/.agents/skills/.orca-skill-extract-1/skill/SKILL.md',
        '700',
        '/home/jin/.agents/skills/.orca-skill-extract-1/skill/scripts/run.sh'
      ])
    )
  })

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

  it('uses manifest mode provenance for Windows-backed WSL paths', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [
      'C:\\Users\\jin\\repo\\.agents\\skills'
    ])
    const manifest = {
      files: [
        { path: 'SKILL.md', executable: false },
        { path: 'scripts/run.sh', executable: true }
      ]
    } as SkillPackageManifestV1

    await filesystem.prepareExtractedSkill(
      'C:\\Users\\jin\\repo\\.agents\\skills\\.orca-skill-extract-1\\skill',
      manifest
    )

    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('rejects a path from another distro before spawning wsl.exe', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    await expect(
      filesystem.remove('\\\\wsl.localhost\\Debian\\home\\jin\\.agents\\skills\\skill')
    ).rejects.toThrow('skill-install-wsl-path-invalid')
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('authorizes a historical provider root before update or removal', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    const historicalRoot =
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\claude-accounts\\old\\auth\\skills'
    filesystem.authorizeRoots([historicalRoot])

    await filesystem.remove(`${historicalRoot}\\private-skill`)

    expect(runWslProcessMock).toHaveBeenCalledOnce()
    expect(runWslProcessMock.mock.calls[0]?.[0].args).toEqual(
      expect.arrayContaining([
        '/home/jin/.local/share/orca/claude-accounts/old/auth/skills/private-skill'
      ])
    )
  })

  it('surfaces a nonzero guest exit as a guest-operation failure', async () => {
    runWslProcessMock.mockResolvedValueOnce({
      code: 42,
      stdout: '',
      stderr: 'mode mismatch',
      timedOut: false
    })
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    await expect(filesystem.remove(`${WSL_ROOT}\\private-skill`)).rejects.toThrow(
      'skill-install-wsl-guest-operation-failed'
    )
  })
})
