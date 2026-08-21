import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const { listFilesWithGitMock } = vi.hoisted(() => ({
  listFilesWithGitMock: vi.fn()
}))

// Why: the fallback is the degraded path #9539 is about — assert it is never reached,
// which is only true when rg resolves without a user-installed binary on PATH.
vi.mock('./filesystem-list-files-git-fallback', () => ({
  listFilesWithGit: listFilesWithGitMock
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

describe('Quick Open with the bundled ripgrep', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    vi.clearAllMocks()
  })

  it('lists files through rg without falling back to git listing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-quick-open-bundled-rg-'))
    const repoPath = join(tempDir, 'repo')
    await execFile('git', ['init', '-q', repoPath])
    await writeFile(join(repoPath, 'tracked.ts'), 'export const a = 1')
    await execFile('git', ['add', 'tracked.ts'], { cwd: repoPath })
    // Why: untracked.ts is never staged, so a git ls-files listing would omit it — its presence
    // proves the result came from rg, while the staged tracked.ts covers the tracked case.
    await writeFile(join(repoPath, 'untracked.ts'), 'export const b = 2')

    const result = await listQuickOpenFiles(repoPath, makeStore(repoPath))

    expect(result).toEqual(expect.arrayContaining(['tracked.ts', 'untracked.ts']))
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
  })
})
