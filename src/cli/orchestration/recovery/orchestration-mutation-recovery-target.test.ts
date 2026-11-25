import { describe, expect, it } from 'vitest'
import { orchestrationMutationRecoveryError } from './orchestration-mutation-recovery'
import { RuntimeClientError } from '../../runtime/connection/types'
import { parseArgs } from '../../arguments/args'

const SEND = ['orca', 'orchestration', 'send', '--type', 'worker_done', '--subject', 'done']

function recover(originalCommand: string[]) {
  const error = orchestrationMutationRecoveryError(
    new RuntimeClientError('runtime_timeout', 'Timed out.', {
      orchestrationRequestId: 'request_1',
      originalCommand
    }),
    { flags: parseArgs(originalCommand.slice(1)).flags }
  )
  if (!(error instanceof RuntimeClientError)) {
    throw new Error('expected a recovery error')
  }
  return error
}

describe('recovery guidance inspects the Orca the command chose', () => {
  it.each([
    ['a named environment', ['--environment', 'devbox'], ['--environment', 'devbox']],
    ['an explicit local route', ['--environment', 'local'], ['--environment', 'local']],
    ['an inline environment', ['--environment=devbox'], ['--environment', 'devbox']],
    ['an outer send via a paired server', ['--on', 'devbox'], ['--environment', 'local']]
  ])('keeps %s in the inspect and retry command', (_case, selection, queryTarget) => {
    const command = [...SEND.slice(0, 3), ...selection, ...SEND.slice(3)]

    const { data } = recover(command)

    expect(data).toMatchObject({
      recovery: {
        queryCommand: [
          'orca',
          'orchestration',
          'request-show',
          '--request',
          'request_1',
          ...queryTarget,
          '--json'
        ],
        retryCommand: [...command, '--retry-request', 'request_1']
      }
    })
  })

  it('names no target when the command chose none', () => {
    expect(recover(SEND).data).toMatchObject({
      recovery: {
        queryCommand: ['orca', 'orchestration', 'request-show', '--request', 'request_1', '--json']
      }
    })
  })

  it('withholds a default-target query when a pairing code chose the Orca, and never repeats the code', () => {
    const error = recover([...SEND, '--pairing-code=private-code'])

    expect(error.data).toMatchObject({
      recovery: { recoveryBlocked: true, disposition: 'outcome_unknown' }
    })
    expect(error.data).not.toHaveProperty('recovery.queryCommand')
    expect(error.message).toContain('with the same --pairing-code this command used')
    expect(error.message).toContain('request-show --request request_1')
    expect(JSON.stringify(error)).not.toContain('private-code')
  })
})
