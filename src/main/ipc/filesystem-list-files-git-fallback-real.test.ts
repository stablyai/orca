import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const { checkRgAvailableMock } = vi.hoisted(() => ({
  checkRgAvailableMock: vi.fn()
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'

const execFile = promisify(execFileCallback)

function makeStore(repoPath: string): Store {
  return {
    getRepos: () => [
      {
        id: 'repo-1',
        path: repoPath,
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git'
      }
    ],
    getSettings: () => ({})
  } as unknown as Store
}

async function writeRel(root: string, relPath: string, content = 'x'): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

async function initRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true })
  await execFile('git', ['init', '-q', repoPath])
  await execFile('git', ['config', 'user.email', 'orca@example.invalid'], { cwd: repoPath })
  await execFile('git', ['config', 'user.name', 'Orca Test'], { cwd: repoPath })
}

describe('filesystem-list-files real git fallback', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    vi.clearAllMocks()
  })

  it('returns real paths for UTF-8 filenames from the git fallback', async () => {
    checkRgAvailableMock.mockResolvedValue(false)
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-git-fallback-'))
    const repoPath = join(tempDir, 'repo')
    await execFile('git', ['init', '-q', repoPath])
    const utf8FileName = '日本語-file.txt'
    await writeFile(join(repoPath, utf8FileName), 'content')
    await execFile('git', ['add', '.'], { cwd: repoPath })

    await expect(listQuickOpenFiles(repoPath, makeStore(repoPath))).resolves.toEqual([utf8FileName])
  })

  it('fills nested git repos from gitlink and untracked embedded-repo entries', async () => {
    checkRgAvailableMock.mockResolvedValue(false)
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-monorepo-'))
    const repoPath = join(tempDir, 'parent')
    const appPath = join(repoPath, 'packages', 'app')
    const libPath = join(repoPath, 'packages', 'lib')
    await initRepo(repoPath)
    await writeRel(repoPath, 'README.md')
    await writeRel(repoPath, 'src/index.ts')
    await execFile('git', ['add', 'README.md', 'src/index.ts'], { cwd: repoPath })

    await initRepo(appPath)
    await writeRel(appPath, 'package.json', '{}')
    await writeRel(appPath, 'src/main.ts')
    await writeRel(appPath, 'node_modules/pkg/index.js')
    await execFile('git', ['add', '.'], { cwd: appPath })
    await execFile('git', ['commit', '-qm', 'init'], { cwd: appPath })
    const { stdout: appSha } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: appPath })
    await execFile(
      'git',
      ['update-index', '--add', '--cacheinfo', `160000,${appSha.trim()},packages/app`],
      { cwd: repoPath }
    )

    await initRepo(libPath)
    await writeRel(libPath, 'package.json', '{}')
    await writeRel(libPath, 'src/lib.ts')

    const result = await listQuickOpenFiles(repoPath, makeStore(repoPath))

    expect(result).toEqual(
      expect.arrayContaining([
        'README.md',
        'src/index.ts',
        'packages/app/package.json',
        'packages/app/src/main.ts',
        'packages/lib/package.json',
        'packages/lib/src/lib.ts'
      ])
    )
    expect(result).not.toContain('packages/app')
    expect(result).not.toContain('packages/lib')
    expect(result).not.toContain('packages/app/node_modules/pkg/index.js')
    expect(result).not.toContain('packages/app/.git/config')
  })

  it('walks a non-git root instead of returning an empty git fallback result', async () => {
    checkRgAvailableMock.mockResolvedValue(false)
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-non-git-'))
    await writeRel(tempDir, 'folder/file.ts')

    await expect(listQuickOpenFiles(tempDir, makeStore(tempDir))).resolves.toEqual([
      'folder/file.ts'
    ])
  })

  it('rejects abnormal git ls-files failures instead of resolving an empty list', async () => {
    checkRgAvailableMock.mockResolvedValue(false)
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-bad-index-'))
    const repoPath = join(tempDir, 'repo')
    await initRepo(repoPath)
    await writeFile(join(repoPath, '.git', 'index'), 'not a git index')

    await expect(listQuickOpenFiles(repoPath, makeStore(repoPath))).rejects.toThrow(
      'git ls-files exited with code'
    )
  })

  it('resolves an empty repo as an empty list', async () => {
    checkRgAvailableMock.mockResolvedValue(false)
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-empty-repo-'))
    const repoPath = join(tempDir, 'repo')
    await initRepo(repoPath)

    await expect(listQuickOpenFiles(repoPath, makeStore(repoPath))).resolves.toEqual([])
  })
})
