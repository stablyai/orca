import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SkillInstallFilesystem } from './skill-install-filesystem'
import { installSharedSkill, removeSharedSkill } from './skill-install-service'
import { createSkillPackageArchive } from './skill-package-creation'
import { createWslSkillInstallFilesystem } from './skill-wsl-install-filesystem'

const execFileAsync = promisify(execFile)
const DISTRO = process.env.ORCA_REAL_WSL_SKILL_DISTRO ?? 'Ubuntu-24.04'
const RUN_REAL_WSL = process.platform === 'win32' && process.env.ORCA_REAL_WSL_SKILL_TEST === '1'

async function runWsl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', ['-d', DISTRO, '--exec', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  })
  return stdout.trim()
}

function uncPath(guestPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${guestPath.replaceAll('/', '\\')}`
}

function interruptThirdRename(filesystem: SkillInstallFilesystem): SkillInstallFilesystem {
  let renameCount = 0
  return {
    prepareExtractedSkill: (path, manifest) => filesystem.prepareExtractedSkill(path, manifest),
    observeSkill: (path, files) => filesystem.observeSkill(path, files),
    rename: async (source, target) => {
      renameCount += 1
      if (renameCount === 3) {
        throw new Error('injected-wsl-commit-interruption')
      }
      await filesystem.rename(source, target)
    },
    remove: (path) => filesystem.remove(path),
    createAlias: (canonicalPath, destinationPath) =>
      filesystem.createAlias!(canonicalPath, destinationPath),
    aliasTargets: (canonicalPath, destinationPath) =>
      filesystem.aliasTargets!(canonicalPath, destinationPath)
  }
}

describe.runIf(RUN_REAL_WSL)('real WSL skill install transactions', () => {
  let localRoot = ''
  let guestRoot = ''
  let homeDirectory = ''
  let workspaceDirectory = ''

  beforeAll(async () => {
    localRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-skill-integration-'))
    guestRoot = await runWsl('mktemp', '-d', '/tmp/orca-skill-integration.XXXXXX')
    if (!guestRoot.startsWith('/tmp/orca-skill-integration.')) {
      throw new Error('unexpected-wsl-integration-root')
    }
    await runWsl('mkdir', '-p', `${guestRoot}/home`, `${guestRoot}/workspace`)
    homeDirectory = uncPath(`${guestRoot}/home`)
    workspaceDirectory = uncPath(`${guestRoot}/workspace`)
  })

  afterAll(async () => {
    await rm(localRoot, { recursive: true, force: true })
    if (guestRoot.startsWith('/tmp/orca-skill-integration.')) {
      await runWsl('rm', '-rf', '--', guestRoot)
    }
  })

  async function packageVersion(versionId: string, heading: string) {
    const source = join(localRoot, `source-${versionId}`)
    await mkdir(source)
    await writeFile(
      join(source, 'SKILL.md'),
      `---\nname: real-wsl-skill\ndescription: Real WSL transaction\n---\n\n# ${heading}\n`
    )
    return createSkillPackageArchive({
      sourceDirectory: source,
      archivePath: join(localRoot, `${versionId}.tar.gz`),
      packageId: 'package-real-wsl',
      versionId
    })
  }

  function installInput(
    archive: Awaited<ReturnType<typeof packageVersion>>,
    scope: 'global' | 'workspace',
    filesystem: SkillInstallFilesystem
  ) {
    return {
      operationId: `operation-${scope}-${archive.manifest.versionId}`,
      archivePath: archive.archivePath,
      scope,
      homeDirectory,
      ...(scope === 'workspace' ? { workspaceDirectory } : {}),
      orcaStateDirectory: join(localRoot, `state-${scope}`),
      detectedProviders: ['codex', 'claude'],
      destinationIdentity: `${scope}:real-wsl`,
      hostIdentity: 'windows-2',
      expectedArchiveSha256: archive.archiveSha256,
      expectedPackageDigest: archive.manifest.packageDigest,
      expectedPackageId: archive.manifest.packageId,
      expectedVersionId: archive.manifest.versionId,
      filesystem,
      wslDistro: DISTRO
    }
  }

  it('installs, recovers, updates, conflicts, and removes on the guest filesystem', async () => {
    const first = await packageVersion('version-1', 'First')
    const second = await packageVersion('version-2', 'Second')
    const filesystem = createWslSkillInstallFilesystem({ distro: DISTRO, homeDirectory })
    const firstInput = installInput(first, 'global', filesystem)
    const secondInput = installInput(second, 'global', filesystem)

    expect((await installSharedSkill(firstInput)).status).toBe('installed')
    expect(await runWsl('test', '-L', `${guestRoot}/home/.claude/skills/real-wsl-skill`)).toBe('')

    await expect(
      installSharedSkill({
        ...secondInput,
        filesystem: interruptThirdRename(filesystem)
      })
    ).rejects.toThrow('injected-wsl-commit-interruption')
    expect(
      await readFile(join(homeDirectory, '.agents', 'skills', 'real-wsl-skill', 'SKILL.md'), 'utf8')
    ).toContain('# First')

    expect((await installSharedSkill(secondInput)).status).toBe('updated')
    await runWsl('touch', `${guestRoot}/home/.agents/skills/real-wsl-skill/local-change`)
    expect((await installSharedSkill(firstInput)).conflict?.kind).toBe('modified')

    const removeInput = {
      operationId: 'remove-global',
      skillName: 'real-wsl-skill',
      scope: 'global' as const,
      homeDirectory,
      orcaStateDirectory: join(localRoot, 'state-global'),
      detectedProviders: ['codex', 'claude'],
      filesystem
    }
    expect((await removeSharedSkill(removeInput)).conflict?.kind).toBe('modified')
    expect(
      (
        await removeSharedSkill({
          ...removeInput,
          conflictResolution: 'replace-and-discard-local'
        })
      ).status
    ).toBe('removed')
    await expect(
      runWsl('test', '-e', `${guestRoot}/home/.agents/skills/real-wsl-skill`)
    ).rejects.toThrow()
  })

  it('installs and removes within a WSL folder workspace', async () => {
    const archive = await packageVersion('workspace-version', 'Workspace')
    const filesystem = createWslSkillInstallFilesystem({
      distro: DISTRO,
      homeDirectory,
      workspaceDirectory
    })
    const input = installInput(archive, 'workspace', filesystem)

    expect((await installSharedSkill(input)).status).toBe('installed')
    expect(
      await readFile(
        join(workspaceDirectory, '.agents', 'skills', 'real-wsl-skill', 'SKILL.md'),
        'utf8'
      )
    ).toContain('# Workspace')
    expect(
      (
        await removeSharedSkill({
          operationId: 'remove-workspace',
          skillName: 'real-wsl-skill',
          scope: 'workspace',
          homeDirectory,
          workspaceDirectory,
          orcaStateDirectory: join(localRoot, 'state-workspace'),
          detectedProviders: ['codex', 'claude'],
          filesystem
        })
      ).status
    ).toBe('removed')
  })

  it('installs and removes within a Windows-backed WSL workspace', async () => {
    const archive = await packageVersion('drvfs-version', 'DrvFS workspace')
    const windowsWorkspace = join(localRoot, 'windows-workspace')
    await mkdir(windowsWorkspace)
    const filesystem = createWslSkillInstallFilesystem({
      distro: DISTRO,
      homeDirectory,
      workspaceDirectory: windowsWorkspace
    })
    const input = {
      ...installInput(archive, 'workspace', filesystem),
      workspaceDirectory: windowsWorkspace,
      orcaStateDirectory: join(localRoot, 'state-drvfs')
    }

    expect((await installSharedSkill(input)).status).toBe('installed')
    expect(
      await readFile(
        join(windowsWorkspace, '.agents', 'skills', 'real-wsl-skill', 'SKILL.md'),
        'utf8'
      )
    ).toContain('# DrvFS workspace')
    expect(
      (
        await removeSharedSkill({
          operationId: 'remove-drvfs',
          skillName: 'real-wsl-skill',
          scope: 'workspace',
          homeDirectory,
          workspaceDirectory: windowsWorkspace,
          orcaStateDirectory: join(localRoot, 'state-drvfs'),
          detectedProviders: ['codex', 'claude'],
          filesystem
        })
      ).status
    ).toBe('removed')
  })
})
