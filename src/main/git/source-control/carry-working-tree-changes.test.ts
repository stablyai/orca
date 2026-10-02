import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { carryLocalWorkingTreeChanges } from './carry-working-tree-changes'

const tempPaths: string[] = []
afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function createRepoWithChild(extraFiles: Record<string, string> = {}): {
  source: string
  target: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-carry-'))
  tempPaths.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '--quiet')
  git(source, 'config', 'user.name', 'Orca Test')
  git(source, 'config', 'user.email', 'orca@example.test')
  git(source, 'config', 'commit.gpgSign', 'false')
  git(source, 'config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  writeFileSync(join(source, 'staged.txt'), 'base\n')
  writeFileSync(join(source, '.gitignore'), 'ignored.log\n')
  for (const [name, contents] of Object.entries(extraFiles)) {
    writeFileSync(join(source, name), contents)
  }
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'base')
  const head = git(source, 'rev-parse', 'HEAD').trim()
  const target = join(root, 'target')
  git(source, 'worktree', 'add', '--quiet', '-b', 'child', target, head)
  return { source, target }
}

describe('carryLocalWorkingTreeChanges', () => {
  it('runs the shared carry through the local git runner', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'new.txt'), 'new\n')

    const result = await carryLocalWorkingTreeChanges(source, target)

    expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 1 })
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(target, 'new.txt'), 'utf8')).toBe('new\n')
  })
})
