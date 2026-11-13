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
})
