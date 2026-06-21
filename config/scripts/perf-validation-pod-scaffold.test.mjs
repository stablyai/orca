import { describe, expect, it, vi } from 'vitest'
import {
  buildPerfValidationPodScaffold,
  parsePerfValidationPodArgs,
  runPerfValidationPodPreflight
} from './perf-validation-pod-scaffold.mjs'

function makeSpawnSync(resultsByCommand) {
  const calls = []
  const spawnSyncImpl = vi.fn((command, args, options) => {
    calls.push({ args, command, options })
    const key = [command, ...args].join(' ')
    return resultsByCommand[key] ?? { signal: null, status: 0, stdout: '', stderr: '' }
  })
  return { calls, spawnSyncImpl }
}

describe('perf-validation-pod-scaffold', () => {
  it('parses pod, run id, artifact root, and check mode', () => {
    expect(
      parsePerfValidationPodArgs([
        '--pod',
        'ssh-relay-batching',
        '--run-id',
        'run-1',
        '--artifact-root',
        '.perf',
        '--check',
        '--json'
      ])
    ).toEqual({
      artifactRoot: '.perf',
      check: true,
      json: true,
      pod: 'ssh-relay-batching',
      runId: 'run-1'
    })
  })

  it('accepts the separator forwarded by pnpm run', () => {
    expect(parsePerfValidationPodArgs(['--', '--pod', 'git-status-coalescing'])).toMatchObject({
      pod: 'git-status-coalescing'
    })
  })

  it('builds durable Playwright artifacts outside test-results', () => {
    const scaffold = buildPerfValidationPodScaffold({
      artifactRoot: '.perf-validation',
      cwd: '/repo/worktree',
      pod: 'terminal-scheduler-adaptive',
      runId: '2026-06-21T23-00'
    })

    expect(scaffold.artifactDir).toBe(
      '.perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive'
    )
    expect(scaffold.baselineCommand).toContain(
      '--output .perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive/playwright-baseline'
    )
    expect(scaffold.baselineCommand).toContain('--reporter=json')
    expect(scaffold.baselineCommand).toContain(
      '> .perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive/terminal-scheduler-baseline-playwright.json'
    )
    expect(scaffold.baselineCommand).not.toContain('> test-results/')
    expect(scaffold.resultPacketPath).toBe(
      '.perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive/result-packet.json'
    )
  })

  it('adds Docker daemon preflight only for the SSH relay pod', () => {
    const ssh = buildPerfValidationPodScaffold({
      pod: 'ssh-relay-batching',
      runId: 'run-1'
    })
    const git = buildPerfValidationPodScaffold({
      pod: 'git-status-coalescing',
      runId: 'run-1'
    })

    expect(ssh.preflightChecks.map((check) => check.name)).toContain('docker-daemon')
    expect(git.preflightChecks.map((check) => check.name)).not.toContain('docker-daemon')
  })

  it('fails preflight before benchmark work when Docker is unavailable', () => {
    const scaffold = buildPerfValidationPodScaffold({
      pod: 'ssh-relay-batching',
      runId: 'run-1'
    })
    const { spawnSyncImpl } = makeSpawnSync({
      'git status --short': { signal: null, status: 0, stdout: '', stderr: '' },
      'pnpm --version': { signal: null, status: 0, stdout: '10.24.0\n', stderr: '' },
      'docker info': {
        signal: null,
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon'
      }
    })

    const result = runPerfValidationPodPreflight({ scaffold, spawnSyncImpl })

    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'docker-daemon',
        ok: false,
        reason: 'Cannot connect to the Docker daemon'
      })
    )
  })

  it('rejects dirty worktrees before baseline artifacts are created', () => {
    const scaffold = buildPerfValidationPodScaffold({
      pod: 'startup-hydration-overlap',
      runId: 'run-1'
    })
    const { spawnSyncImpl } = makeSpawnSync({
      'git status --short': { signal: null, status: 0, stdout: ' M src/App.tsx\n', stderr: '' },
      'pnpm --version': { signal: null, status: 0, stdout: '10.24.0\n', stderr: '' }
    })

    const result = runPerfValidationPodPreflight({ scaffold, spawnSyncImpl })

    expect(result.ok).toBe(false)
    expect(result.checks[0]).toEqual({
      name: 'git-clean',
      ok: false,
      reason: 'worktree has uncommitted changes',
      details: ' M src/App.tsx'
    })
  })
})
