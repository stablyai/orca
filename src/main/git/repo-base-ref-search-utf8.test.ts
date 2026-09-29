import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../shared/git-output-locale'
import { parseAndFilterSearchRefDetails } from './repo-base-ref-search'

/**
 * Regression for the garbled branch picker: a branch whose UTF-8 encoding contains
 * 0xA0 (`渠` is E6 B8 A0) came back cut mid-sequence, because git's
 * shorten_unambiguous_ref() parses with sscanf("%s") and macOS libc calls 0xA0
 * whitespace under a UTF-8 LC_CTYPE.
 *
 * Real git, not a mock: the truncation happens inside the binary, so a mocked
 * stdout would assert nothing about the bug.
 */
const CHINESE_BRANCH = 'sprint139/m-7109863708-【渠道】CRM营销工具接口变动与代付发券替换PRD'
const SEARCH_FORMAT = '--format=%(refname)%00%(refname:short)'

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })
}

/** The locale Orca used before the fix, which is what makes libc cut the name. */
const TRUNCATING_LOCALE_ENV = { LANGUAGE: 'en', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }

describe('branch names containing 0xA0 in their UTF-8 encoding', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-ref-utf8-'))
    git(repo, ['init', '--quiet'])
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(repo, ['config', 'user.email', 'test@test.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['commit', '--allow-empty', '-m', 'initial', '--quiet'])
    git(repo, ['branch', CHINESE_BRANCH])
    git(repo, ['update-ref', `refs/remotes/origin/${CHINESE_BRANCH}`, 'HEAD'])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps %(refname) intact even where the locale truncates %(refname:short)', () => {
    const stdout = git(
      repo,
      ['for-each-ref', SEARCH_FORMAT, `refs/heads/${CHINESE_BRANCH}`],
      TRUNCATING_LOCALE_ENV
    )
    const [fullRef] = stdout.trim().split('\0')

    expect(fullRef).toBe(`refs/heads/${CHINESE_BRANCH}`)
  })

  it('returns the whole branch name under the locale Orca now pins', () => {
    const stdout = git(
      repo,
      ['for-each-ref', SEARCH_FORMAT, `refs/heads/${CHINESE_BRANCH}`],
      UNTRANSLATED_GIT_OUTPUT_ENV
    )

    expect(parseAndFilterSearchRefDetails(stdout, 10, ['origin'])).toEqual([
      { refName: CHINESE_BRANCH, localBranchName: CHINESE_BRANCH }
    ])
  })

  it('repairs the name even when the host locale truncates it', () => {
    const stdout = git(
      repo,
      ['for-each-ref', SEARCH_FORMAT, `refs/heads/${CHINESE_BRANCH}`],
      TRUNCATING_LOCALE_ENV
    )

    expect(parseAndFilterSearchRefDetails(stdout, 10, ['origin'])).toEqual([
      { refName: CHINESE_BRANCH, localBranchName: CHINESE_BRANCH }
    ])
  })

  it('repairs a remote-tracking branch the host locale truncates', () => {
    const stdout = git(
      repo,
      ['for-each-ref', SEARCH_FORMAT, `refs/remotes/origin/${CHINESE_BRANCH}`],
      TRUNCATING_LOCALE_ENV
    )

    expect(parseAndFilterSearchRefDetails(stdout, 10, ['origin'])).toEqual([
      { refName: `origin/${CHINESE_BRANCH}`, localBranchName: CHINESE_BRANCH }
    ])
  })

  it('reads the checked-out branch whole with symbolic-ref, no --short', () => {
    git(repo, ['checkout', '--quiet', CHINESE_BRANCH])

    const full = git(repo, ['symbolic-ref', '--quiet', 'HEAD'], TRUNCATING_LOCALE_ENV).trim()

    expect(full).toBe(`refs/heads/${CHINESE_BRANCH}`)
  })

  it('leaves pure-ASCII branches untouched', () => {
    const stdout = git(repo, ['for-each-ref', SEARCH_FORMAT, 'refs/heads/main'])

    expect(parseAndFilterSearchRefDetails(stdout, 10, ['origin'])).toEqual([
      { refName: 'main', localBranchName: 'main' }
    ])
  })
})
