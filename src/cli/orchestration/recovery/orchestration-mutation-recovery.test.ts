import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  orchestrationMutationRecoveryError,
  renderCommand
} from './orchestration-mutation-recovery'
import { RuntimeClientError } from '../../runtime/connection/types'

describe('orchestration mutation recovery', () => {
  it.runIf(process.platform !== 'win32')(
    'round trips POSIX recovery argv through /bin/sh',
    async () => {
      const values = ['with spaces', "apostrophe's", 'literal $(do-not-run)', 'line one\nline two']
      const command = renderCommand(
        [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
          ...values
        ],
        'darwin'
      )

      const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })

      expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
      expect(JSON.parse(result.stdout)).toEqual(values)
    }
  )

  it.each([
    [
      'split',
      ['orca', 'orchestration', 'send', '--pairing-code', 'split-secret', '--subject', 'status'],
      'split-secret'
    ],
    [
      'equals',
      ['orca', 'orchestration', 'send', '--pairing-code=equals-secret', '--subject', 'status'],
      'equals-secret'
    ],
    [
      'dispatch split',
      [
        'orca',
        'orchestration',
        'send',
        '--dispatch-capability',
        'split-dispatch-secret',
        '--subject',
        'status'
      ],
      'split-dispatch-secret'
    ],
    [
      'dispatch equals',
      [
        'orca',
        'orchestration',
        'send',
        '--dispatch-capability=equals-dispatch-secret',
        '--subject',
        'status'
      ],
      'equals-dispatch-secret'
    ]
  ])('blocks recovery and removes %s credentials', (_name, originalCommand, secret) => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_secret',
        originalCommand
      })
    ) as RuntimeClientError
    const output = JSON.stringify({ message: result.message, data: result.data })

    expect(output).not.toContain(secret)
    expect(result.message).toContain('Recovery is blocked')
    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_secret',
        recoveryBlocked: true
      }
    })
    expect(result.data).not.toHaveProperty('originalCommand')
    expect((result.data as { recovery: object }).recovery).not.toHaveProperty('retryCommand')
  })

  it('answers mail still being delivered on a paired server with a retry of the same request', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError(
        'delivery_in_progress',
        'This mail is still being delivered on devB; nothing more was applied.',
        {
          orchestrationRequestId: 'request_slow',
          originalCommand: ['orca', 'orchestration', 'send', '--on', 'devB', '--subject', 'hi']
        }
      )
    )

    if (!(result instanceof RuntimeClientError)) {
      throw new Error('expected a recovery error')
    }
    expect(result.data).toMatchObject({
      recovery: {
        retryCommand: [
          'orca',
          'orchestration',
          'send',
          '--on',
          'devB',
          '--subject',
          'hi',
          '--retry-request',
          'request_slow'
        ],
        disposition: 'in_progress'
      }
    })
    expect(result.message).toContain('--retry-request request_slow')
  })

  it('keeps plain Windows cmd tokens unquoted while still quoting spaces, =, and percent signs', () => {
    const rendered = renderCommand(
      [
        'orca-dev',
        'orchestration',
        'send',
        '--on',
        'devB',
        '--subject',
        'two words',
        '--note=100% safe',
        '--retry-request',
        'request_slow'
      ],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    )

    expect(rendered).toBe(
      'orca-dev orchestration send --on devB --subject "two words" "--note=100"^%" safe" --retry-request request_slow'
    )
  })
})
