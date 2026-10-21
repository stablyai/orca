import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDaemonProtocolCrossing } from './check-daemon-protocol-crossing.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH } from './daemon-protocol-facts.mjs'
import { selectLatestStableReleaseTag } from './stable-release-tags.mjs'

const repos = []

function expectedLatest(tags) {
  let latest = null
  let latestParts = []
  for (const tag of tags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
    if (!match) {
      continue
    }
    const parts = match.slice(1).map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
    let comparison = 0
    for (let index = 0; index < 3 && comparison === 0; index++) {
      comparison = parts[index] - (latestParts[index] ?? 0)
    }
    if (latest === null || comparison >= 0) {
      latest = tag
      latestParts = parts
    }
  }
  return latest
}

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
  for (const [tag, protocol] of tagged) {
    writeProtocol(repo, protocol)
    git(repo, ['add', '.'])
    git(repo, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      tag
    ])
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

  it.each([0, 1, 12, 128, 1000])(
    'selects numerically without changing %i Git tag strings',
    (count) => {
      const tags = Array.from(
        { length: count },
        (_, index) => `v1.${(index * 37) % 17}.${(index * 101) % (count + 1)}`
      )
      const input = [...tags]
      const expected = expectedLatest(tags)
      expect(selectLatestStableReleaseTag(Object.freeze(tags))).toBe(expected)
      expect(tags).toEqual(input)
    }
  )

  it('preserves tie spelling, numeric fallback and invalid-tag admission', () => {
    const cases = [
      { tags: [], expected: null },
      { tags: ['nightly', 'mobile-v1.2.3', 'v1.2.3-rc.1'], expected: null },
      { tags: ['v0001.4.003', 'v1.04.3'], expected: 'v1.04.3' },
      { tags: ['v1.04.3', 'v0001.4.003'], expected: 'v0001.4.003' },
      { tags: ['v1.2.3', 'v1.2.3\n'], expected: 'v1.2.3' },
      { tags: ['v1.2.3\r\n', 'v0.0.1'], expected: 'v0.0.1' },
      { tags: [`v${'9'.repeat(400)}.1.2`, 'v0.1.2'], expected: 'v0.1.2' },
      {
        tags: ['v9007199254740993.1.0', 'v9007199254740992.1.0'],
        expected: 'v9007199254740992.1.0'
      }
    ]
    for (const { tags, expected } of cases) {
      const input = [...tags]
      expect(selectLatestStableReleaseTag(Object.freeze(tags))).toBe(expected)
      expect(tags).toEqual(input)
    }
    const sparse = []
    sparse.length = 12
    sparse[3] = 'v1.2.3'
    sparse[8] = 'v2.0.0'
    expect(selectLatestStableReleaseTag(Object.freeze(sparse))).toBe('v2.0.0')
  })

  it('selects the same latest spelling across ordinary version namespaces and repeated calls', () => {
    let randomState = 673151
    const next = () => {
      randomState = (randomState * 1664525 + 1013904223) >>> 0
      return randomState
    }
    for (let seed = 0; seed < 256; seed++) {
      const tags = []
      for (let index = 0, count = next() % 129; index < count; index++) {
        const triple = [next() % 13, next() % 17, next() % 257]
        const prefix = next() % 8 === 0 ? 'mobile-v' : 'v'
        const suffix = next() % 9 === 0 ? '-rc.1' : ''
        tags.push(`${prefix}${triple.join('.')}${suffix}`)
        if (index % 11 === 0) {
          tags.push(tags.at(-1))
        }
      }
      const input = [...tags]
      const expected = expectedLatest(tags)
      expect(selectLatestStableReleaseTag(tags)).toBe(expected)
      expect(tags).toEqual(input)
      tags.push('v99.99.99')
      expect(selectLatestStableReleaseTag(tags)).toBe('v99.99.99')
    }
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
