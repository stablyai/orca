import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { readFirstWorkHeadState } from './first-work-head-state'

let root = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {
      cwd,
      stdio: 'ignore'
    }
  )
}

function repo(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  return dir
}

function withCommit(name: string): string {
  const dir = repo(name)
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

const read = (cwd: string) => readFirstWorkHeadState((args) => gitExecFileAsync(args, { cwd }))

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-first-work-head-')))
  // Isolated from user and system Git config, and from any repository above the fixture root.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CEILING_DIRECTORIES', root)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('production HEAD classifier on real Git', () => {
  it('attached branch', async () => {
    expect(await read(withCommit('attached'))).toEqual({ kind: 'branch', name: 'main' })
  })

  it('unborn branch', async () => {
    expect(await read(repo('unborn'))).toEqual({ kind: 'branch', name: 'main' })
  })

  it('detached HEAD', async () => {
    const dir = withCommit('detached')
    git(dir, 'checkout', '-q', '--detach')
    expect(await read(dir)).toEqual({ kind: 'detached' })
  })

  it('tag symref', async () => {
    const dir = withCommit('tag-symref')
    git(dir, 'tag', 't1')
    git(dir, 'symbolic-ref', 'HEAD', 'refs/tags/t1')
    expect(await read(dir)).toEqual({ kind: 'unknown' })
  })

  it('non-repository', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    expect(await read(dir)).toEqual({ kind: 'unknown' })
  })
})
