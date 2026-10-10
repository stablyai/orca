import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureRealGitTestRepo } from '../../src/main/git/real-git-test-repo.ts'
import { checkDaemonProtocolCrossing } from './check-daemon-protocol-crossing.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH } from './daemon-protocol-facts.mjs'
import { selectLatestStableReleaseTag } from './stable-release-tags.mjs'

const repos = []

function git(repo, args) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

function writeProtocol(repo, current) {
  const previous = Array.from({ length: current - 1 }, (_, index) => index + 1)
  const file = join(repo, DAEMON_PROTOCOL_SOURCE_PATH)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `export const PROTOCOL_VERSION = ${current}\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [${previous.join(', ')}] as const\n`
  )
}

function repoWithTags(tagged) {
  const repo = mkdtempSync(join(tmpdir(), 'daemon-protocol-crossing-'))
  repos.push(repo)
  git(repo, ['init', '-q'])
  configureRealGitTestRepo(repo, { name: 'test', email: 'test@example.com' })
  for (const [tag, protocol] of tagged) {
    writeProtocol(repo, protocol)
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', tag])
    git(repo, ['tag', tag])
  }
  return repo
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true })
  }
})

describe('selectLatestStableReleaseTag', () => {
  it('orders numerically and skips prerelease tags', () => {
    expect(selectLatestStableReleaseTag(['v1.4.9', 'v1.4.10', 'v1.5.0-rc.1', 'nightly'])).toBe(
      'v1.4.10'
    )
    expect(selectLatestStableReleaseTag(['nightly'])).toBeNull()
  })
})

describe('checkDaemonProtocolCrossing', () => {
  const env = {}

  it('passes a bump that lists the newest release version, reporting rollback as info', () => {
    const repo = repoWithTags([
      ['v1.0.9', 5],
      ['v1.0.10', 6]
    ])
    writeProtocol(repo, 7)
    const result = checkDaemonProtocolCrossing({ repoRoot: repo, env })
    expect(result).toMatchObject({ upgrade: true, rollback: false })
    expect(result.lines[0]).toBe('release v1.0.10: daemon protocol 6')
  })

  it('fails when the working tree drops the newest release version', () => {
    const repo = repoWithTags([['v1.0.0', 6]])
    writeFileSync(
      join(repo, DAEMON_PROTOCOL_SOURCE_PATH),
      'export const PROTOCOL_VERSION = 7\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1, 2, 3, 4, 5] as const\n'
    )
    const result = checkDaemonProtocolCrossing({ repoRoot: repo, env })
    expect(result.upgrade).toBe(false)
    expect(result.lines.join('\n')).toContain('add 6 to PREVIOUS_DAEMON_PROTOCOL_VERSIONS')
  })

  it('refuses to pass silently without release tags', () => {
    const repo = repoWithTags([['nightly', 6]])
    expect(() => checkDaemonProtocolCrossing({ repoRoot: repo, env })).toThrow(
      /no stable release tags/
    )
  })

  it('honors an explicit release ref', () => {
    const repo = repoWithTags([
      ['v1.0.0', 5],
      ['v1.0.1', 6]
    ])
    const result = checkDaemonProtocolCrossing({ repoRoot: repo, releaseRef: 'v1.0.0', env })
    expect(result).toMatchObject({ upgrade: true, rollback: false })
    expect(result.lines[0]).toBe('release v1.0.0: daemon protocol 5')
  })
})
