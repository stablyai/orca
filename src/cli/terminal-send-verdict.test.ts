import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from './index'
import { formatTerminalSend } from './terminal-format'
import { okFixture, queueFixtures } from './test-fixtures'

// A host older than submit verdicts answers `terminal.send` with no `submitVerdict` field. Printing
// only the byte count there let an unproven submission read as a completed one.

const SEND_ARGS = ['terminal', 'send', '--terminal', 'term_abc', '--text', 'ship it', '--enter']

describe('formatTerminalSend', () => {
  it('reports unknown when a verdict was requested and the host returned none', () => {
    const output = formatTerminalSend(
      { send: { handle: 'term_abc', accepted: true, bytesWritten: 8 } },
      { verdictRequested: true }
    )

    expect(output).toContain('Submit verdict: unknown')
    expect(output).toContain('the host returned no verdict')
  })

  it('stays quiet about verdicts when this invocation never asked for one', () => {
    expect(
      formatTerminalSend({ send: { handle: 'term_abc', accepted: true, bytesWritten: 8 } })
    ).toBe('Sent 8 bytes to term_abc.')
  })

  it('renders the host verdict when there is one', () => {
    const output = formatTerminalSend(
      {
        send: {
          handle: 'term_abc',
          accepted: true,
          bytesWritten: 8,
          submitVerdict: {
            status: 'pending',
            reason: 'no-turn-start-observed',
            waitedMs: 2500,
            resubmitted: true
          }
        }
      },
      { verdictRequested: true }
    )

    expect(output).toContain('Submit verdict: pending after one submit retry')
    expect(output).toContain('no-turn-start-observed')
  })
})

describe('orca terminal send against a host with no submit verdict', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says the submission is unproven instead of printing bytes alone', async () => {
    queueFixtures(
      callMock,
      okFixture('req', { send: { handle: 'term_abc', accepted: true, bytesWritten: 8 } })
    )

    await main(SEND_ARGS, '/tmp/repo')

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('Submit verdict: unknown')
    expect(output).toContain('the host returned no verdict')
  })

  it('leaves the JSON response exactly as the host sent it', async () => {
    queueFixtures(
      callMock,
      okFixture('req', { send: { handle: 'term_abc', accepted: true, bytesWritten: 8 } })
    )

    await main([...SEND_ARGS, '--json'], '/tmp/repo')

    // Why: the CLI knows only that IT asked; inventing a verdict field would put a claim the host
    // never made into a machine-readable result.
    const parsed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(parsed.result.send).toEqual({ handle: 'term_abc', accepted: true, bytesWritten: 8 })
  })

  it('does not mention verdicts for a send that carries no submit', async () => {
    queueFixtures(
      callMock,
      okFixture('req', { send: { handle: 'term_abc', accepted: true, bytesWritten: 7 } })
    )

    await main(['terminal', 'send', '--terminal', 'term_abc', '--text', 'ship it'], '/tmp/repo')

    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Submit verdict')
  })

  it('does not mention verdicts when --no-verdict skipped the wait', async () => {
    queueFixtures(
      callMock,
      okFixture('req', { send: { handle: 'term_abc', accepted: true, bytesWritten: 8 } })
    )

    await main([...SEND_ARGS, '--no-verdict'], '/tmp/repo')

    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Submit verdict')
  })
})

describe('orca orchestration dispatch --inject against a host with no submit verdict', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns that the preamble is unconfirmed when the verdict field is absent', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
        injected: false
      })
    )

    await main(
      [
        'orchestration',
        'dispatch',
        '--task',
        'task_1',
        '--to',
        'term_w',
        '--from',
        'term_c',
        '--inject'
      ],
      '/tmp/repo'
    )

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('Preamble NOT confirmed submitted')
    expect(output).toContain('the host returned no verdict')
  })

  it('stays quiet when the dispatch was not an injection', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' }
      })
    )

    await main(
      ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_w', '--from', 'term_c'],
      '/tmp/repo'
    )

    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('NOT confirmed submitted')
  })
})
