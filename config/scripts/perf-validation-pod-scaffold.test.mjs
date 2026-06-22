import { describe, expect, it, vi } from 'vitest'
import {
  buildPerfValidationPodScaffold,
  parsePerfValidationPodArgs,
  runPerfValidationPodPreflight
} from './perf-validation-pod-scaffold.mjs'
import { runPerfValidationPodVariant } from './run-perf-validation-pod.mjs'

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

  it('builds cross-platform Node runner commands with durable Playwright artifacts', () => {
    const scaffold = buildPerfValidationPodScaffold({
      artifactRoot: '.perf-validation',
      cwd: '/repo/worktree',
      pod: 'terminal-scheduler-adaptive',
      runId: '2026-06-21T23-00'
    })

    expect(scaffold.artifactDir).toBe(
      '.perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive'
    )
    expect(scaffold.baselineCommand).toBe(
      'node config/scripts/run-perf-validation-pod.mjs --pod terminal-scheduler-adaptive --run-id 2026-06-21T23-00 --artifact-root .perf-validation --variant baseline'
    )
    expect(scaffold.baselineCommand).not.toMatch(/\s&&\s|>|\b[A-Za-z_][A-Za-z0-9_]*=/u)
    expect(scaffold.baselineArtifactPath).toBe(
      '.perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive/terminal-scheduler-baseline-playwright.json'
    )
    expect(scaffold.resultPacketPath).toBe(
      '.perf-validation/2026-06-21T23-00/terminal-scheduler-adaptive/result-packet.json'
    )
  })

  it('builds Node runner commands without POSIX shell syntax for every pod', () => {
    for (const pod of [
      'ssh-relay-batching',
      'git-status-coalescing',
      'terminal-scheduler-adaptive',
      'startup-hydration-overlap'
    ]) {
      const scaffold = buildPerfValidationPodScaffold({
        artifactRoot: '.perf-validation',
        pod,
        runId: 'run-1'
      })

      expect(scaffold.baselineCommand).toBe(
        `node config/scripts/run-perf-validation-pod.mjs --pod ${pod} --run-id run-1 --artifact-root .perf-validation --variant baseline`
      )
      expect(scaffold.candidateCommand).toBe(
        `node config/scripts/run-perf-validation-pod.mjs --pod ${pod} --run-id run-1 --artifact-root .perf-validation --variant candidate`
      )
      expect(`${scaffold.baselineCommand}\n${scaffold.candidateCommand}`).not.toMatch(
        /\s&&\s|>|\b[A-Za-z_][A-Za-z0-9_]*=/u
      )
    }
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

    const result = runPerfValidationPodPreflight({
      mkdirSyncImpl: vi.fn(),
      scaffold,
      spawnSyncImpl
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'docker-daemon',
        ok: false,
        reason: 'Cannot connect to the Docker daemon'
      })
    )
  })

  it('runs Playwright pods without shell redirection or POSIX env assignment', () => {
    const scaffold = buildPerfValidationPodScaffold({
      artifactRoot: '.perf-validation',
      cwd: '/repo/worktree',
      pod: 'terminal-scheduler-adaptive',
      runId: 'run-1'
    })
    const writes = []
    const { calls, spawnSyncImpl } = makeSpawnSync({
      'pnpm run ensure:electron-runtime': { signal: null, status: 0, stdout: '', stderr: '' },
      'pnpm exec playwright test tests/e2e/terminal-output-scheduler.spec.ts tests/e2e/terminal-typing-latency.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1 --repeat-each=5 --reporter=json --output .perf-validation/run-1/terminal-scheduler-adaptive/playwright-baseline':
        {
          signal: null,
          status: 0,
          stdout: '{"status":"passed"}\n',
          stderr: ''
        }
    })

    const result = runPerfValidationPodVariant({
      scaffold,
      mkdirSyncImpl: vi.fn(),
      spawnSyncImpl,
      variant: 'baseline',
      writeFileSyncImpl: (file, content) => writes.push({ content, file })
    })

    expect(result).toEqual({ ok: true, status: 0 })
    expect(calls).toEqual([
      {
        args: ['run', 'ensure:electron-runtime'],
        command: 'pnpm',
        options: { cwd: '/repo/worktree', encoding: 'utf8', env: process.env }
      },
      {
        args: [
          'exec',
          'playwright',
          'test',
          'tests/e2e/terminal-output-scheduler.spec.ts',
          'tests/e2e/terminal-typing-latency.spec.ts',
          '--config',
          'tests/playwright.config.ts',
          '--project',
          'electron-headless',
          '--workers=1',
          '--repeat-each=5',
          '--reporter=json',
          '--output',
          '.perf-validation/run-1/terminal-scheduler-adaptive/playwright-baseline'
        ],
        command: 'pnpm',
        options: { cwd: '/repo/worktree', encoding: 'utf8', env: process.env }
      }
    ])
    expect(writes).toEqual([
      {
        content: '{"status":"passed"}\n',
        file: '.perf-validation/run-1/terminal-scheduler-adaptive/terminal-scheduler-baseline-playwright.json'
      }
    ])
  })

  it('passes perf artifact paths through explicit env instead of inline shell assignment', () => {
    const scaffold = buildPerfValidationPodScaffold({
      artifactRoot: '.perf-validation',
      cwd: '/repo/worktree',
      pod: 'ssh-relay-batching',
      runId: 'run-1'
    })
    const writes = []
    const { calls, spawnSyncImpl } = makeSpawnSync({
      'pnpm run test:e2e:ssh-docker-perf -- --repeat-each=5 --reporter=json --output .perf-validation/run-1/ssh-relay-batching/playwright-candidate':
        {
          signal: null,
          status: 0,
          stdout: '{"status":"passed"}\n',
          stderr: ''
        }
    })

    const result = runPerfValidationPodVariant({
      env: { PATH: '/bin' },
      scaffold,
      mkdirSyncImpl: vi.fn(),
      spawnSyncImpl,
      variant: 'candidate',
      writeFileSyncImpl: (file, content) => writes.push({ content, file })
    })

    expect(result).toEqual({ ok: true, status: 0 })
    expect(calls).toEqual([
      {
        args: [
          'run',
          'test:e2e:ssh-docker-perf',
          '--',
          '--repeat-each=5',
          '--reporter=json',
          '--output',
          '.perf-validation/run-1/ssh-relay-batching/playwright-candidate'
        ],
        command: 'pnpm',
        options: {
          cwd: '/repo/worktree',
          encoding: 'utf8',
          env: {
            ORCA_E2E_SSH_DOCKER_PERF_JSON:
              '.perf-validation/run-1/ssh-relay-batching/ssh-relay-candidate.jsonl',
            PATH: '/bin'
          }
        }
      }
    ])
    expect(writes).toEqual([
      {
        content: '{"status":"passed"}\n',
        file: '.perf-validation/run-1/ssh-relay-batching/ssh-relay-candidate-playwright.json'
      }
    ])
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

    const result = runPerfValidationPodPreflight({
      mkdirSyncImpl: vi.fn(),
      scaffold,
      spawnSyncImpl
    })

    expect(result.ok).toBe(false)
    expect(result.checks[0]).toEqual({
      name: 'git-clean',
      ok: false,
      reason: 'worktree has uncommitted changes',
      details: ' M src/App.tsx'
    })
  })
})
