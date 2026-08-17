import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SkillInstallDestination } from '../../shared/skill-install-contract'
import { executeSkillInstallRequest } from './skill-install-request-service'
import { createSkillPackageArchive } from './skill-package-creation'

const execFileAsync = promisify(execFile)
const RUN_REAL_WINDOWS =
  process.platform === 'win32' && process.env.ORCA_REAL_WINDOWS_SKILL_TEST === '1'

describe.runIf(RUN_REAL_WINDOWS)('real Windows skill workspace installation', () => {
  let root = ''
  let homeDirectory = ''
  let gitWorktree = ''
  let folderWorkspace = ''
  let stateDirectory = ''
  let archive: Awaited<ReturnType<typeof createSkillPackageArchive>>

  async function git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
        GIT_CONFIG_SYSTEM: join(root, 'system.gitconfig'),
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    return stdout.trim()
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-windows-skill-integration-'))
    homeDirectory = join(root, 'host home-é')
    const repository = join(root, 'repository')
    gitWorktree = join(root, 'Git worktree-é')
    folderWorkspace = join(root, 'Folder workspace-é')
    stateDirectory = join(root, 'orca state')
    const source = join(root, 'Skill source-é')
    await Promise.all([
      mkdir(homeDirectory),
      mkdir(repository),
      mkdir(folderWorkspace),
      mkdir(source),
      writeFile(join(root, 'global.gitconfig'), ''),
      writeFile(join(root, 'system.gitconfig'), '')
    ])
    await git(['init', '--quiet'], repository)
    await git(['config', 'user.name', 'Orca Test'], repository)
    await git(['config', 'user.email', 'orca@example.invalid'], repository)
    await writeFile(join(repository, 'README.md'), 'fixture\n')
    await git(['add', 'README.md'], repository)
    await git(['commit', '--quiet', '-m', 'fixture'], repository)
    await git(['worktree', 'add', '--quiet', '-b', 'skill-fixture', gitWorktree], repository)
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: real-windows-skill\ndescription: Real Windows workspace\n---\n\n# Windows\n'
    )
    archive = await createSkillPackageArchive({
      sourceDirectory: source,
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package-real-windows',
      versionId: 'version-1'
    })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function install(destination: SkillInstallDestination, operationId: string) {
    return executeSkillInstallRequest(
      {
        operationId,
        package: {
          packageId: archive.manifest.packageId,
          versionId: archive.manifest.versionId,
          packageDigest: archive.manifest.packageDigest,
          archiveSha256: archive.archiveSha256,
          compressedBytes: archive.compressedBytes
        },
        ingress: { kind: 'local-file', path: archive.archivePath },
        destination
      },
      {
        authority: {
          environmentId: 'windows-2',
          homeDirectory,
          resolveWorktree: async (id) =>
            id === 'real-worktree' ? { id, path: gitWorktree } : null,
          resolveFolderWorkspace: async (id) =>
            id === 'real-folder' ? { id, path: folderWorkspace } : null
        },
        stateDirectory,
        allowedDownloadOrigins: [],
        requireHttps: true,
        allowTrustedLocalFile: true,
        detectProviders: async () => []
      }
    )
  }

  it('resolves host home and installs globally without a client-supplied destination path', async () => {
    expect((await install({ scope: 'global', environmentId: 'windows-2' }, 'global')).status).toBe(
      'installed'
    )
    expect(
      await readFile(
        join(homeDirectory, '.agents', 'skills', 'real-windows-skill', 'SKILL.md'),
        'utf8'
      )
    ).toContain('# Windows')
  })

  it('installs independently into a real Git worktree and a plain folder workspace', async () => {
    expect(await git(['rev-parse', '--is-inside-work-tree'], gitWorktree)).toBe('true')
    const worktreeResult = await install(
      { scope: 'workspace', worktreeId: 'real-worktree' },
      'worktree'
    )
    const folderResult = await install(
      { scope: 'workspace', folderWorkspaceId: 'real-folder' },
      'folder'
    )

    expect(worktreeResult.status).toBe('installed')
    expect(folderResult.status).toBe('installed')
    for (const workspace of [gitWorktree, folderWorkspace]) {
      expect(
        await readFile(
          join(workspace, '.agents', 'skills', 'real-windows-skill', 'SKILL.md'),
          'utf8'
        )
      ).toContain('# Windows')
    }
  })
})
