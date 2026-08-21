import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePorcelainV1Records } from './porcelain-v1-records'

const tempRoots: string[] = []

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'orca-porcelain-v1-'))
  tempRoots.push(repo)
  git(['init', '-q', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  return repo
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('parsePorcelainV1Records', () => {
  it('returns [] for a clean status', () => {
    expect(parsePorcelainV1Records('')).toEqual([])
  })

  it('keeps paths containing spaces and quotes intact', () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a file "quoted".txt'), 'x')

    const records = parsePorcelainV1Records(git(['status', '--porcelain', '-z'], repo))

    expect(records).toEqual([{ xy: '??', path: 'a file "quoted".txt' }])
  })

  it('keeps non-ASCII paths raw rather than C-quoted', () => {
    const repo = createRepo()
    writeFileSync(join(repo, '日本語.txt'), 'x')

    expect(parsePorcelainV1Records(git(['status', '--porcelain', '-z'], repo))).toEqual([
      { xy: '??', path: '日本語.txt' }
    ])
  })

  // Why: a rename emits its ORIGIN as a second NUL field. Reading that origin as
  // its own record would invent a status code from the first bytes of a path —
  // and `?? ` is exactly what the shared-symlink filter keys on.
  it('consumes the origin path of a rename instead of emitting it as a record', () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'original.txt'), 'content\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'init'], repo)
    git(['mv', 'original.txt', 'renamed.txt'], repo)

    const records = parsePorcelainV1Records(git(['status', '--porcelain', '-z'], repo))

    expect(records).toEqual([{ xy: 'R ', path: 'renamed.txt' }])
  })

  it('reports a rename alongside a later untracked entry', () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'original.txt'), 'content\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'init'], repo)
    git(['mv', 'original.txt', 'renamed.txt'], repo)
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'node_modules', 'pkg.js'), 'x')

    const records = parsePorcelainV1Records(git(['status', '--porcelain', '-z'], repo))

    expect(records).toEqual([
      { xy: 'R ', path: 'renamed.txt' },
      { xy: '??', path: 'node_modules/' }
    ])
  })

  it('parses staged and unstaged codes distinctly', () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'init'], repo)
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n')

    expect(parsePorcelainV1Records(git(['status', '--porcelain', '-z'], repo))).toEqual([
      { xy: ' M', path: 'tracked.txt' }
    ])
  })
})
