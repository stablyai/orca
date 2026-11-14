import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_PROTOCOL_OVERRIDE_ENV,
  checkRuntimeLauncherProtocolRatchet
} from './check-runtime-launcher-protocol-ratchet.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH } from '../schema-facts/daemon-protocol-facts.mjs'
const repos = []
const LAUNCHER = 'src/main/managed-server/install/orcad-remote-runtime.ts'

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function write(repo, path, contents) {
  const file = join(repo, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function writeProtocol(repo, current) {
  const previous = Array.from({ length: current - 1 }, (_, index) => index + 1)
  write(
    repo,
    DAEMON_PROTOCOL_SOURCE_PATH,
    `export const PROTOCOL_VERSION = ${current}\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [${previous.join(', ')}] as const\n`
  )
}

function commit(repo, message) {
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
    message
  ])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

/** A base commit at protocol 3, then a candidate commit shaped by `change`. */
function repoWithCandidate(change) {
  const repo = mkdtempSync(join(tmpdir(), 'runtime-launcher-ratchet-'))
  repos.push(repo)
  git(repo, ['init', '-q'])
  writeProtocol(repo, 3)
  write(repo, LAUNCHER, 'export const launcher = 1\n')
  write(repo, 'src/unrelated.ts', 'export const unrelated = 1\n')
  const base = commit(repo, 'base')
  change(repo)
  commit(repo, 'candidate')
  return { repo, base }
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true })
  }
})

describe('checkRuntimeLauncherProtocolRatchet against git history', () => {
  it('fails when the diff from the base both edits a launcher and bumps PROTOCOL_VERSION', () => {
    const { repo, base } = repoWithCandidate((candidate) => {
      writeProtocol(candidate, 4)
      write(candidate, LAUNCHER, 'export const launcher = 2\n')
    })
    expect(checkRuntimeLauncherProtocolRatchet({ repoRoot: repo, base, env: {} }).ok).toBe(false)
    expect(
      checkRuntimeLauncherProtocolRatchet({
        repoRoot: repo,
        base,
        env: { [RUNTIME_PROTOCOL_OVERRIDE_ENV]: 'true' }
      }).ok
    ).toBe(true)
  })

  it('passes a bump next to unrelated edits', () => {
    const { repo, base } = repoWithCandidate((candidate) => {
      writeProtocol(candidate, 4)
      write(candidate, 'src/unrelated.ts', 'export const unrelated = 2\n')
    })
    expect(checkRuntimeLauncherProtocolRatchet({ repoRoot: repo, base, env: {} }).ok).toBe(true)
  })

  it('ignores edits to the protocol file that keep PROTOCOL_VERSION', () => {
    const { repo, base } = repoWithCandidate((candidate) => {
      write(
        candidate,
        DAEMON_PROTOCOL_SOURCE_PATH,
        '// comment\nexport const PROTOCOL_VERSION = 3\nexport const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1, 2] as const\n'
      )
      write(candidate, LAUNCHER, 'export const launcher = 2\n')
    })
    expect(checkRuntimeLauncherProtocolRatchet({ repoRoot: repo, base, env: {} }).ok).toBe(true)
  })
})
