import { describe, expect, it } from 'vitest'
import { buildOrchestrationRecoveryCommand } from './orchestration-recovery-command'

describe('orchestration recovery command identity', () => {
  it('removes both first-send and retry identities before recovery appends its one id', () => {
    expect(
      buildOrchestrationRecoveryCommand('orchestration.workerStart', {}, 'orca', [
        'orchestration',
        'worker-start',
        '--task',
        'task_1',
        '--request-id',
        '11111111-2222-4333-8444-555555555555',
        '--retry-request=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      ])
    ).toEqual(['orca', 'orchestration', 'worker-start', '--task', 'task_1'])
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

  it('does not fabricate identity for unsupported mutations or malformed params', () => {
    expect(buildOrchestrationRecoveryCommand('orchestration.send', {})).toBeUndefined()
    expect(buildOrchestrationRecoveryCommand('orchestration.workerStart', null)).toBeUndefined()
  })
})
