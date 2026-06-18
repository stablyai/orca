import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
