import { describe, expect, it } from 'vitest'
import {
  buildOrchestrationRecoveryCommand,
  resolveOrchestrationCliExecutable
} from './orchestration-recovery-command'

describe('orchestration recovery command identity', () => {
  it.each([
    ['configured dev', { ORCA_CLI_COMMAND: 'orca-dev' }, 'darwin', 'orca-dev'],
    ['configured WSL', { ORCA_CLI_COMMAND: 'orca-ide' }, 'linux', 'orca-ide'],
    ['dev checkout', { ORCA_DEV_REPO_ROOT: '/repo' }, 'darwin', 'orca-dev'],
    ['packaged Linux', {}, 'linux', 'orca-ide'],
    ['local macOS', {}, 'darwin', 'orca'],
    ['local Windows', {}, 'win32', 'orca']
  ] as const)('resolves the %s CLI identity', (_name, env, platform, expected) => {
    expect(resolveOrchestrationCliExecutable(env, platform)).toBe(expected)
  })

  it('reconstructs the keyed worker-start command from its RPC params', () => {
    expect(
      buildOrchestrationRecoveryCommand(
        'orchestration.workerStart',
        {
          task: 'task_1',
          on: 'windows',
          worktree: 'new-top-level',
          timeoutMs: 90_000,
          devMode: false
        },
        'orca'
      )
    ).toEqual([
      'orca',
      'orchestration',
      'worker-start',
      '--task',
      'task_1',
      '--on',
      'windows',
      '--worktree',
      'new-top-level',
      '--timeout-ms',
      '90000'
    ])
  })

  it('preserves the selected executable and raw command arguments', () => {
    expect(
      buildOrchestrationRecoveryCommand(
        'orchestration.workerStart',
        { task: 'task_1' },
        'orca-dev',
        [
          'orchestration',
          'worker-start',
          '--task',
          'task_1',
          '--comment',
          'literal $(do-not-run) "quoted"',
          '--json'
        ]
      )
    ).toEqual([
      'orca-dev',
      'orchestration',
      'worker-start',
      '--task',
      'task_1',
      '--comment',
      'literal $(do-not-run) "quoted"',
      '--json'
    ])
  })

  it.each([
    [
      'gate-create',
      'orchestration.gateCreate',
      ['orchestration', 'gate-create', '--task', 'task_1', '--question', 'ship?']
    ],
    [
      'worker-retain',
      'orchestration.workerRetain',
      ['orchestration', 'worker-retain', '--dispatch', 'dispatch_1', '--json']
    ]
  ] as const)('preserves exact raw argv for %s recovery', (_name, method, args) => {
    expect(buildOrchestrationRecoveryCommand(method, {}, 'orca', args)).toEqual(['orca', ...args])
  })

  it.each([
    ['split', ['orchestration', 'send', '--pairing-code', 'secret', '--subject', 'status']],
    ['equals', ['orchestration', 'send', '--pairing-code=secret', '--subject', 'status']],
    [
      'dispatch split',
      ['orchestration', 'send', '--dispatch-capability', 'secret', '--subject', 'status']
    ],
    [
      'dispatch equals',
      ['orchestration', 'send', '--dispatch-capability=secret', '--subject', 'status']
    ]
  ])('blocks %s credential argv instead of exposing it', (_name, args) => {
    expect(
      buildOrchestrationRecoveryCommand('orchestration.send', {}, 'orca', args)
    ).toBeUndefined()
  })

  it('supports the explicit executable-first form', () => {
    expect(
      buildOrchestrationRecoveryCommand('orca-ide', 'orchestration.workerStop', {
        dispatch: 'dispatch_1'
      })
    ).toEqual(['orca-ide', 'orchestration', 'worker-stop', '--dispatch', 'dispatch_1'])
  })

  it('reconstructs worker-retain when raw argv is unavailable', () => {
    expect(
      buildOrchestrationRecoveryCommand('orchestration.workerRetain', {
        dispatch: 'dispatch_1'
      })
    ).toEqual([
      resolveOrchestrationCliExecutable(),
      'orchestration',
      'worker-retain',
      '--dispatch',
      'dispatch_1'
    ])
  })

  it('does not fabricate identity for unsupported mutations or malformed params', () => {
    expect(buildOrchestrationRecoveryCommand('orchestration.send', {})).toBeUndefined()
    expect(buildOrchestrationRecoveryCommand('orchestration.workerStart', null)).toBeUndefined()
  })
})
