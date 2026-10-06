import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_LAUNCHER_PATHS,
  RUNTIME_PROTOCOL_OVERRIDE_ENV,
  assessRuntimeLauncherProtocolRatchet,
  checkRuntimeLauncherProtocolRatchet,
  isOverrideEnabled
} from './check-runtime-launcher-protocol-ratchet.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH } from './daemon-protocol-facts.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const repos = []
const LAUNCHER = 'src/main/ssh/orcad-remote-runtime.ts'

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

describe('RUNTIME_LAUNCHER_PATHS', () => {
  it('names only files that exist, so a rename cannot silently drop one from the gate', () => {
    expect(RUNTIME_LAUNCHER_PATHS.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([])
  })
})

describe('PR routing', () => {
  it('runs the ratchet job when its checker or the protocol changes', () => {
    for (const file of [
      'config/scripts/check-runtime-launcher-protocol-ratchet.mjs',
      DAEMON_PROTOCOL_SOURCE_PATH
    ]) {
      expect(classifyPrJobs([file])['cross-version-wire']).toBe(true)
    }
  })
})

describe('assessRuntimeLauncherProtocolRatchet', () => {
  const launcherAndBump = {
    changedFiles: [LAUNCHER, DAEMON_PROTOCOL_SOURCE_PATH],
    baseProtocolVersion: 3,
    candidateProtocolVersion: 4
  }

  it('fails a launcher change that also bumps the protocol', () => {
    expect(
      assessRuntimeLauncherProtocolRatchet({ ...launcherAndBump, overridden: false })
    ).toMatchObject({
      ok: false,
      violated: true
    })
  })

  it('lets an explicit override through while still reporting the violation', () => {
    const result = assessRuntimeLauncherProtocolRatchet({ ...launcherAndBump, overridden: true })
    expect(result).toMatchObject({ ok: true, violated: true })
    expect(result.lines.at(-1)).toContain('OVERRIDDEN')
  })

  it('passes a protocol bump without a launcher change, and a launcher change without a bump', () => {
    expect(
      assessRuntimeLauncherProtocolRatchet({
        ...launcherAndBump,
        changedFiles: [DAEMON_PROTOCOL_SOURCE_PATH],
        overridden: false
      }).ok
    ).toBe(true)
    expect(
      assessRuntimeLauncherProtocolRatchet({
        ...launcherAndBump,
        candidateProtocolVersion: 3,
        overridden: false
      }).ok
    ).toBe(true)
  })
})

describe('isOverrideEnabled', () => {
  it('accepts only an explicit true', () => {
    expect(isOverrideEnabled({ [RUNTIME_PROTOCOL_OVERRIDE_ENV]: 'true' })).toBe(true)
    expect(isOverrideEnabled({ [RUNTIME_PROTOCOL_OVERRIDE_ENV]: '1' })).toBe(true)
    expect(isOverrideEnabled({ [RUNTIME_PROTOCOL_OVERRIDE_ENV]: 'false' })).toBe(false)
    expect(isOverrideEnabled({ [RUNTIME_PROTOCOL_OVERRIDE_ENV]: '' })).toBe(false)
    expect(isOverrideEnabled({})).toBe(false)
  })
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
