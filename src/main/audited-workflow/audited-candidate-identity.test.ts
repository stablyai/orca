// Phase 7 candidate identity, against a REAL Git repository.
//
// C2 is the decisive test: it enumerates the repository's object store before and
// after derivation and requires the file set to be byte-identical. It is the test
// that FAILS against a temp-index-only design, which silently persists the bytes
// of uncommitted and untracked files into the user's .git/objects.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { deriveCandidateTree, getCandidateRunDir } from './audited-candidate-identity'

let repoRoot: string
let worktreePath: string
let userData: string
let baseCommit: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Every loose/packed object file under the repository's common object dir. */
function objectFiles(): string[] {
  const objectsDir = join(repoRoot, '.git', 'objects')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        found.push(full)
      }
    }
  }
  walk(objectsDir)
  return found.sort()
}

function baseArgs(overrides: Partial<Parameters<typeof deriveCandidateTree>[0]> = {}) {
  return {
    runId: 'exec_00112233445566aa',
    userDataPath: userData,
    worktreePath,
    sourceRepoPath: worktreePath,
    baseCommit,
    wslDistro: null,
    hostId: 'local',
    ...overrides
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-cand-ud-'))
  repoRoot = mkdtempSync(join(tmpdir(), 'orca-cand-repo-'))
  git(repoRoot, 'init', '-q', '.')
  git(repoRoot, 'config', 'user.email', 'test@example.com')
  git(repoRoot, 'config', 'user.name', 'Test')
  git(repoRoot, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoRoot, 'tracked.txt'), 'base content\n', 'utf8')
  writeFileSync(join(repoRoot, '.gitignore'), 'ignored.txt\n', 'utf8')
  git(repoRoot, 'add', 'tracked.txt', '.gitignore')
  git(repoRoot, 'commit', '-qm', 'base')
  baseCommit = git(repoRoot, 'rev-parse', 'HEAD')

  // The real deployment shape: a linked worktree on its own branch at base.
  worktreePath = join(tmpdir(), `orca-cand-wt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  git(
    repoRoot,
    'worktree',
    'add',
    '-q',
    '--no-track',
    '-b',
    'audited/task',
    worktreePath,
    baseCommit
  )
})

afterEach(() => {
  for (const dir of [worktreePath, repoRoot, userData]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('deriveCandidateTree', () => {
  it('derives a tree OID for modified and untracked content', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')
    writeFileSync(join(worktreePath, 'added.txt'), 'new file\n', 'utf8')

    const result = await deriveCandidateTree(baseArgs())

    expect(result.ok).toBe(true)
    expect(result.ok && result.treeOid).toMatch(/^[0-9a-f]{40}$/)
  })

  // C1
  it('is deterministic across two runs over identical content', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')

    const first = await deriveCandidateTree(baseArgs({ runId: 'exec_aaaaaaaaaaaaaaaa' }))
    const second = await deriveCandidateTree(baseArgs({ runId: 'exec_bbbbbbbbbbbbbbbb' }))

    expect(first.ok && second.ok).toBe(true)
    expect(first.ok && second.ok && first.treeOid).toBe(second.ok ? second.treeOid : '')
  })

  // C2 — THE OBJECT-STORAGE PROOF.
  it('creates NO new object in the real repository object store', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'modified secret\n', 'utf8')
    writeFileSync(join(worktreePath, 'untracked.txt'), 'untracked secret\n', 'utf8')
    const before = objectFiles()

    const result = await deriveCandidateTree(baseArgs())
    expect(result.ok).toBe(true)

    expect(objectFiles()).toEqual(before)

    // The candidate tree itself must be absent from the real store.
    expect(() => git(worktreePath, 'cat-file', '-e', result.ok ? result.treeOid : '')).toThrow()

    // And so must the untracked file's blob — the bytes a temp-index-only design
    // would have persisted.
    const untrackedBlob = git(worktreePath, 'hash-object', join(worktreePath, 'untracked.txt'))
    expect(() => git(worktreePath, 'cat-file', '-e', untrackedBlob)).toThrow()
  })

  // C3
  it('leaves the real index untouched', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')
    writeFileSync(join(worktreePath, 'untracked.txt'), 'new\n', 'utf8')
    const statusBefore = git(worktreePath, 'status', '--porcelain')

    await deriveCandidateTree(baseArgs())

    expect(git(worktreePath, 'status', '--porcelain')).toBe(statusBefore)
    expect(existsSync(join(repoRoot, '.git', 'index.lock'))).toBe(false)
  })

  // C4
  it('excludes gitignored files and includes untracked non-ignored ones', async () => {
    writeFileSync(join(worktreePath, 'ignored.txt'), 'should not count\n', 'utf8')
    const ignoredOnly = await deriveCandidateTree(baseArgs({ runId: 'exec_1111111111111111' }))
    // Ignored-only means nothing actually changed -> empty change set.
    expect(ignoredOnly).toEqual({ ok: false, reasonCode: 'empty_change_set' })

    writeFileSync(join(worktreePath, 'visible.txt'), 'counts\n', 'utf8')
    const withUntracked = await deriveCandidateTree(baseArgs({ runId: 'exec_2222222222222222' }))
    expect(withUntracked.ok).toBe(true)
  })

  // C5
  it('reports empty_change_set when nothing changed', async () => {
    expect(await deriveCandidateTree(baseArgs())).toEqual({
      ok: false,
      reasonCode: 'empty_change_set'
    })
  })

  // C6
  it('removes the whole per-run directory, including the temp objects', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')

    await deriveCandidateTree(baseArgs())

    expect(existsSync(getCandidateRunDir(userData, 'exec_00112233445566aa'))).toBe(false)
  })

  it('still cleans up when a Git step fails', async () => {
    // A base commit that does not exist makes read-tree fail.
    const result = await deriveCandidateTree(baseArgs({ baseCommit: 'b'.repeat(40) }))

    expect(result).toEqual({ ok: false, reasonCode: 'candidate_derivation_failed' })
    expect(existsSync(getCandidateRunDir(userData, 'exec_00112233445566aa'))).toBe(false)
  })

  // C9
  it.each([
    ['a WSL distro', { wslDistro: 'Ubuntu' }],
    ['a non-local host', { hostId: 'ssh-prod' }]
  ])('refuses %s before any Git spawn', async (_label, overrides) => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')
    const before = objectFiles()

    expect(await deriveCandidateTree(baseArgs(overrides))).toEqual({
      ok: false,
      reasonCode: 'candidate_host_unsupported'
    })
    expect(objectFiles()).toEqual(before)
    expect(existsSync(getCandidateRunDir(userData, 'exec_00112233445566aa'))).toBe(false)
  })

  it('refuses a non-OID base commit', async () => {
    expect(await deriveCandidateTree(baseArgs({ baseCommit: 'HEAD' }))).toEqual({
      ok: false,
      reasonCode: 'candidate_path_unsupported'
    })
  })

  // C10 — Git 2.25 compatibility. readCommonDir already degrades from
  // --path-format=absolute (Git >= 2.31) to the bare form; deriving against a
  // repo path whose common dir resolves through EITHER route must agree.
  it('resolves the common dir on the 2.25-compatible path', async () => {
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')

    // The bare form is what Git 2.25 supports; from a linked worktree it is
    // already absolute, which is always the audited case.
    const bare = git(worktreePath, 'rev-parse', '--git-common-dir')
    expect(bare.length).toBeGreaterThan(0)

    const viaWorktree = await deriveCandidateTree(
      baseArgs({ sourceRepoPath: worktreePath, runId: 'exec_3333333333333333' })
    )
    const viaRepo = await deriveCandidateTree(
      baseArgs({ sourceRepoPath: repoRoot, runId: 'exec_4444444444444444' })
    )

    // Same content, same objects store, therefore the same identity regardless of
    // which path form resolved the common dir.
    expect(viaWorktree.ok).toBe(true)
    expect(viaRepo.ok).toBe(true)
    expect(viaWorktree.ok && viaRepo.ok && viaWorktree.treeOid).toBe(
      viaRepo.ok ? viaRepo.treeOid : ''
    )
  })

  it('matches the tree a plain temp-index run would produce', async () => {
    // C2c: the object redirect must not change content identity. Compute the
    // reference with a temp index only (the withdrawn design) and compare.
    writeFileSync(join(worktreePath, 'tracked.txt'), 'changed\n', 'utf8')
    writeFileSync(join(worktreePath, 'added.txt'), 'new\n', 'utf8')

    const referenceIndex = join(userData, 'reference-index')
    mkdirSync(join(userData, 'ref'), { recursive: true })
    const env = { ...process.env, GIT_INDEX_FILE: referenceIndex }
    execFileSync('git', ['read-tree', baseCommit], { cwd: worktreePath, env })
    execFileSync('git', ['add', '-A', '--'], { cwd: worktreePath, env })
    const reference = execFileSync('git', ['write-tree'], {
      cwd: worktreePath,
      env,
      encoding: 'utf8'
    }).trim()

    const result = await deriveCandidateTree(baseArgs({ runId: 'exec_5555555555555555' }))

    expect(result.ok && result.treeOid).toBe(reference)
  })
})
