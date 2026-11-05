import { runProcessSync } from '@orca/process-host'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readGitBaselineSources } from './git-baseline-sources.mjs'

let repo

afterEach(() => {
  if (repo) {
    rmSync(repo, { recursive: true, force: true })
  }
})

it('reads the selected revision before and after a move, preserving its import directory', () => {
  repo = mkdtempSync(join(tmpdir(), 'orca-git-baseline-'))
  const git = (...args) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: repo,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Baseline Test',
      '-c',
      'user.email=baseline@example.test',
      'commit',
      '-qm',
      'source'
    )
    return git('rev-parse', 'HEAD')
  }
  const historical = 'src/main/daemon/entry.ts'
  const current = 'src/main/daemon/launch/entry.ts'
  const originalSource = "import './dependency'\nexport const version = 'original'\n"
  const movedSource = "import './dependency'\nexport const version = 'moved'\n"
  git('init', '--quiet')
  mkdirSync(dirname(join(repo, historical)), { recursive: true })
  writeFileSync(join(repo, historical), originalSource)
  const beforeMove = commit()
  mkdirSync(dirname(join(repo, current)), { recursive: true })
  renameSync(join(repo, historical), join(repo, current))
  writeFileSync(join(repo, current), movedSource)
  const afterMove = commit()
  writeFileSync(join(repo, current), 'throw new Error("dirty worktree must not be read")\n')

  for (const [ref, expectedSource, expectedPath] of [
    [beforeMove, originalSource, historical],
    [afterMove, movedSource, current]
  ]) {
    const selected = readGitBaselineSources(repo, ref, new Map([[current, `${ref}:${historical}`]]))
    expect(selected.get(join(repo, current))).toEqual({
      contents: expectedSource,
      resolveDir: dirname(join(repo, expectedPath))
    })
  }
  expect(() =>
    readGitBaselineSources(
      repo,
      beforeMove,
      new Map([['src/main/absent.ts', `${beforeMove}:src/main/also-absent.ts`]])
    )
  ).toThrow('Pinned Docker baseline source is absent:')
})
