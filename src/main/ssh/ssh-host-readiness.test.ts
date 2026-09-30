import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseSshReadiness, SSH_READINESS_PROBE_SCRIPT } from './ssh-host-readiness'

const PROBE_KEYS = [
  'node',
  'toolchain',
  'github',
  'gh-auth',
  'git-identity',
  'claude',
  'codex'
]

function probeLine(key: string, state: string, detail: string): string {
  return `${key}\t${state}\t${detail}`
}

describe('parseSshReadiness', () => {
  it('reads every probed line in the probe script’s wire order', () => {
    const stdout = [
      probeLine('node', 'ok', 'v20.11.1'),
      probeLine('toolchain', 'miss', 'missing g++'),
      probeLine('github', 'ok', 'git ls-remote github.com ok'),
      probeLine('gh-auth', 'ok', 'octocat'),
      probeLine('git-identity', 'ok', 'dev@example.com'),
      probeLine('claude', 'ok', 'oauth_token'),
      probeLine('codex', 'ok', 'logged-in')
    ].join('\n')

    expect(parseSshReadiness(stdout, 1700000000000)).toEqual({
      checks: [
        { key: 'node', state: 'ok', detail: 'v20.11.1' },
        { key: 'toolchain', state: 'miss', detail: 'missing g++' },
        { key: 'github', state: 'ok', detail: 'git ls-remote github.com ok' },
        { key: 'gh-auth', state: 'ok', detail: 'octocat' },
        { key: 'git-identity', state: 'ok', detail: 'dev@example.com' },
        { key: 'claude', state: 'ok', detail: 'oauth_token' },
        { key: 'codex', state: 'ok', detail: 'logged-in' }
      ],
      probedAt: 1700000000000
    })
  })

  it('reports a check the probe never printed as unknown, never as a pass', () => {
    const report = parseSshReadiness(probeLine('node', 'ok', 'v20.11.1'), 1)

    expect(report.checks.map((check) => check.key)).toEqual(PROBE_KEYS)
    expect(report.checks[0]).toEqual({ key: 'node', state: 'ok', detail: 'v20.11.1' })
    for (const check of report.checks.slice(1)) {
      expect(check.state).toBe('unknown')
      expect(check.detail).toBe('')
    }
  })

  it('ignores malformed lines instead of guessing a verdict', () => {
    const stdout = [
      '',
      'node',
      'node\tok',
      probeLine('node', 'maybe', 'not a state'),
      probeLine('npm-outdated', 'ok', 'not a check this client knows'),
      probeLine('', 'ok', 'no key'),
      probeLine('toolchain', 'ok', 'make and g++ present')
    ].join('\n')

    const report = parseSshReadiness(stdout, 1)

    expect(report.checks.filter((check) => check.state !== 'unknown')).toEqual([
      { key: 'toolchain', state: 'ok', detail: 'make and g++ present' }
    ])
  })

  it('flattens tabs inside a detail and cuts it to 120 chars', () => {
    const report = parseSshReadiness(
      [probeLine('codex', 'ok', 'a\tb'), probeLine('gh-auth', 'ok', 'x'.repeat(200))].join('\n'),
      1
    )

    expect(report.checks[6]).toEqual({ key: 'codex', state: 'ok', detail: 'a b' })
    expect(report.checks[3].detail).toBe('x'.repeat(120))
  })
})

describe('SSH_READINESS_PROBE_SCRIPT', () => {
  // Tests may spawn directly and `runProcess` does not help here: the string itself is the
  // artifact under test, and `sh -n` is the only thing that proves it is still runnable shell.
  it.skipIf(process.platform === 'win32')('is valid POSIX sh', () => {
    const result = spawnSync('sh', ['-n'], {
      input: SSH_READINESS_PROBE_SCRIPT,
      encoding: 'utf8'
    })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('emits a line for every key the parser expects', () => {
    for (const key of PROBE_KEYS) {
      expect(SSH_READINESS_PROBE_SCRIPT).toContain(`orca_emit ${key} `)
    }
  })
})
