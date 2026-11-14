import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDaemonProtocolCrossing } from './check-daemon-protocol-crossing.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH } from '../schema-facts/daemon-protocol-facts.mjs'

const repos = []

function git(repo, args) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

function writeProtocol(repo, current, sourcePath = DAEMON_PROTOCOL_SOURCE_PATH) {
  const previous = Array.from({ length: current - 1 }, (_, index) => index + 1)
  const file = join(repo, sourcePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `export const PROTOCOL_VERSION = ${current}\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [${previous.join(', ')}] as const\n`
  )
}

function repoWithTags(tagged, sourcePath = DAEMON_PROTOCOL_SOURCE_PATH) {
  const repo = mkdtempSync(join(tmpdir(), 'daemon-protocol-crossing-'))
  repos.push(repo)
  git(repo, ['init', '-q'])
  for (const [tag, protocol] of tagged) {
    writeProtocol(repo, protocol, sourcePath)
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

describe('checkDaemonProtocolCrossing', () => {
  it.each(['src/main/daemon/daemon-protocol-version.ts', DAEMON_PROTOCOL_SOURCE_PATH])(
    'reads the pinned release from %s while checking the dirty candidate',
    (sourcePath) => {
      const repo = repoWithTags([['v1.0.0', 5]], sourcePath)
      writeFileSync(join(repo, sourcePath), 'invalid dirty release source\n')
      writeProtocol(repo, 6)
      const result = checkDaemonProtocolCrossing({ repoRoot: repo, env: {} })
      expect(result).toMatchObject({ upgrade: true, rollback: false })
      expect(result.lines[0]).toBe('release v1.0.0: daemon protocol 5')
      expect(result.lines[1]).toBe('candidate (working tree): daemon protocol 6')
    }
  )

  const env = {}

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
})
