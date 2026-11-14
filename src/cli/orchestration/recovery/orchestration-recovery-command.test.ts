import { describe, expect, it } from 'vitest'
import { buildOrchestrationRecoveryCommand } from './orchestration-recovery-command'

describe('orchestration recovery request identity', () => {
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
})
