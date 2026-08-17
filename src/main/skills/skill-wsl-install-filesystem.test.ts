import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
}))

import {
  createWslSkillInstallFilesystem,
  WslSkillInstallFilesystem
} from './skill-wsl-install-filesystem'

const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.agents\\skills'

beforeEach(() => {
  execFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
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

    expect(execFileAsyncMock).toHaveBeenCalledTimes(8)
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

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    const calls = execFileAsyncMock.mock.calls.map(([, args]) => args as string[])
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
    expect(execFileAsyncMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '/mnt/c/Users/jin/repo/.agents/skills/.skill.orca-staging-1',
        '/mnt/c/Users/jin/repo/.agents/skills/skill'
      ])
    )
    await expect(filesystem.remove('C:\\Users\\jin\\repo\\unrelated')).rejects.toThrow(
      'skill-install-wsl-path-outside-root'
    )
    expect(execFileAsyncMock).toHaveBeenCalledOnce()
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

    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects a path from another distro before spawning wsl.exe', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    await expect(
      filesystem.remove('\\\\wsl.localhost\\Debian\\home\\jin\\.agents\\skills\\skill')
    ).rejects.toThrow('skill-install-wsl-path-invalid')
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('authorizes a historical provider root before update or removal', async () => {
    const filesystem = new WslSkillInstallFilesystem('Ubuntu-24.04', [WSL_ROOT])
    const historicalRoot =
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\claude-accounts\\old\\auth\\skills'
    filesystem.authorizeRoots([historicalRoot])

    await filesystem.remove(`${historicalRoot}\\private-skill`)

    expect(execFileAsyncMock).toHaveBeenCalledOnce()
    expect(execFileAsyncMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '/home/jin/.local/share/orca/claude-accounts/old/auth/skills/private-skill'
      ])
    )
  })
})
