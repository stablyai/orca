import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as fsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSharedWorktreeAdminFingerprintProbesForTests,
  readRepoWorktreeAdminFingerprint,
  startSharedRepoWorktreeAdminFingerprintProbe
} from './repo-worktree-admin-fingerprint'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args))
  }
})

let tempDir = ''

function createGitRepoFixture(): { repoDir: string; gitDir: string; linkedAdminDir: string } {
  tempDir = mkdtempSync(path.join(tmpdir(), 'orca-admin-fp-'))
  const repoDir = path.join(tempDir, 'repo')
  const gitDir = path.join(repoDir, '.git')
  const linkedWorktreeDir = path.join(tempDir, 'wt-a')
  const linkedAdminDir = path.join(gitDir, 'worktrees', 'wt-a')
  mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
  mkdirSync(linkedAdminDir, { recursive: true })
  mkdirSync(linkedWorktreeDir, { recursive: true })
  writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(
    path.join(gitDir, 'refs', 'heads', 'main'),
    '1111111111111111111111111111111111111111\n'
  )
  writeFileSync(
    path.join(gitDir, 'refs', 'heads', 'feature'),
    '2222222222222222222222222222222222222222\n'
  )
  writeFileSync(path.join(linkedAdminDir, 'gitdir'), `${path.join(linkedWorktreeDir, '.git')}\n`)
  writeFileSync(path.join(linkedAdminDir, 'HEAD'), 'ref: refs/heads/feature\n')
  return { repoDir, gitDir, linkedAdminDir }
}

afterEach(() => {
  vi.clearAllMocks()
  _resetSharedWorktreeAdminFingerprintProbesForTests()
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('repo worktree admin fingerprint', () => {
  it('skips linked headDir lookups for shared refs and avoids double-reading packed main refs', async () => {
    const { repoDir, gitDir, linkedAdminDir } = createGitRepoFixture()
    // Remove loose main ref to simulate a packed ref on the main checkout.
    rmSync(path.join(gitDir, 'refs', 'heads', 'main'))
    const readFileMock = vi.mocked(fsPromises.readFile)
    readFileMock.mockClear()

    const fp = await readRepoWorktreeAdminFingerprint(repoDir)
    expect(fp).not.toBeNull()

    const readPaths = readFileMock.mock.calls.map(([target]) => String(target))
    // Must not attempt guaranteed-ENOENT read of refs/heads/feature inside .git/worktrees/wt-a.
    expect(readPaths).not.toContain(path.join(linkedAdminDir, 'refs', 'heads', 'feature'))
    expect(readPaths).toContain(path.join(gitDir, 'refs', 'heads', 'feature'))
    // Packed main ref must be checked at most once in commonDir.
    const mainRefReads = readPaths.filter((p) => p === path.join(gitDir, 'refs', 'heads', 'main'))
    expect(mainRefReads).toHaveLength(1)
  })

  it('still reads per-worktree refs from the linked worktree admin directory', async () => {
    const { repoDir, linkedAdminDir } = createGitRepoFixture()
    mkdirSync(path.join(linkedAdminDir, 'refs', 'worktree'), { recursive: true })
    writeFileSync(path.join(linkedAdminDir, 'HEAD'), 'ref: refs/worktree/custom\n')
    writeFileSync(
      path.join(linkedAdminDir, 'refs', 'worktree', 'custom'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    )

    const fp1 = await readRepoWorktreeAdminFingerprint(repoDir)
    writeFileSync(
      path.join(linkedAdminDir, 'refs', 'worktree', 'custom'),
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    )
    const fp2 = await readRepoWorktreeAdminFingerprint(repoDir)

    expect(fp1).not.toBeNull()
    expect(fp2).not.toBeNull()
    expect(fp2).not.toBe(fp1)
  })

  it('coalesces concurrent shared probes per repo into in-flight', async () => {
    const { repoDir } = createGitRepoFixture()
    const first = startSharedRepoWorktreeAdminFingerprintProbe('repo-1', repoDir)
    expect(first).not.toBe('in-flight')
    const second = startSharedRepoWorktreeAdminFingerprintProbe('repo-1', repoDir)
    expect(second).toBe('in-flight')

    expect(await (first as Promise<string | null>)).not.toBeNull()
    const third = startSharedRepoWorktreeAdminFingerprintProbe('repo-1', repoDir)
    expect(third).not.toBe('in-flight')
    expect(await (third as Promise<string | null>)).not.toBeNull()
  })
})
