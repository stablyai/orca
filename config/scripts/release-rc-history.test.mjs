import { runProcessSync } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  highestRcForBase,
  rcNumberFromReleaseSubject,
  rcNumberFromTag
} from './release-rc-history.mjs'

function git(cwd, args) {
  const result = runProcessSync({ program: 'git', args, cwd, timeoutMs: 10_000 })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

function withGitRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-rc-history-'))
  try {
    git(dir, ['init', '--initial-branch=main'])
    git(dir, ['config', 'user.name', 'Test Bot'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    // Why: global tag.gpgsign turns lightweight fixture tags into annotated ones that need a message.
    git(dir, ['config', 'commit.gpgsign', 'false'])
    git(dir, ['config', 'tag.gpgsign', 'false'])
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function commit(cwd, message, { allowEmpty = true } = {}) {
  const args = ['commit', '-m', message]
  if (allowEmpty) {
    args.splice(1, 0, '--allow-empty')
  }
  git(cwd, args)
}

describe('release RC history', () => {
  it('parses only exact desktop RC tag suffixes', () => {
    expect(rcNumberFromTag('1.4.36', 'v1.4.36-rc.7')).toBe(7)
    expect(rcNumberFromTag('1.4.36', 'v1.4.36-rc.7-extra')).toBeNull()
    expect(rcNumberFromTag('1.4.36', 'v1.4.35-rc.7')).toBeNull()
  })

  it('parses release commit subjects with optional slot markers', () => {
    expect(rcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6')).toBe(6)
    expect(
      rcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6 [rc-slot:2026-05-30-03]')
    ).toBe(6)
    expect(rcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6-extra')).toBeNull()
    expect(rcNumberFromReleaseSubject('1.4.36', 'fix: v1.4.36-rc.6')).toBeNull()
  })

  it('counts a suffixed side-branch RC from its subject as well as its tag', () => {
    expect(rcNumberFromTag('1.4.36', 'v1.4.36-rc.6.perf')).toBe(6)
    expect(rcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6.perf')).toBe(6)
    expect(
      rcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6.perf [rc-slot:2026-05-30-03]')
    ).toBe(6)
  })

  it('keeps a suffixed RC counted once its tag is deleted', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.5')
      git(repo, ['tag', 'v1.4.36-rc.5'])
      // Deleted tags leave only commit subject: undercounting suffixed RC permits explicit release below clients’ current build.
      commit(repo, 'release: v1.4.36-rc.6.perf')
      git(repo, ['tag', 'v1.4.36-rc.6.perf'])
      git(repo, ['tag', '--delete', 'v1.4.36-rc.6.perf'])

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })

  it('keeps RC numbers monotonic after a stale tag is deleted', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.5')
      git(repo, ['tag', 'v1.4.36-rc.5'])
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])
      git(repo, ['tag', '--delete', 'v1.4.36-rc.6'])

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })

  it('considers origin/main when releasing from an older ref', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      git(repo, ['checkout', 'HEAD~1'])

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })
  it('counts an RC tag independently of release subjects and returns null without either record', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      expect(highestRcForBase('1.4.36', { cwd: repo })).toBeNull()
      git(repo, ['tag', 'v1.4.36-rc.7'])
      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(7)
      git(repo, ['tag', '--delete', 'v1.4.36-rc.7'])
      expect(highestRcForBase('1.4.36', { cwd: repo })).toBeNull()
    })
  })
})
