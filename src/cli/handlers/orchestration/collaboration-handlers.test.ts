import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, getTerminalHandleMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  getTerminalHandleMock: vi.fn()
}))

vi.mock('../../runtime-client', async () => {
  // Why: re-export the REAL error classes so format.ts `instanceof` narrowing still matches.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../../runtime/types.js')
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

vi.mock('../../selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTerminalHandle: getTerminalHandleMock
}))

import { main } from '../../index'
import { okFixture, queueFixtures } from '../../test-fixtures'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

const publishFixture = (overrides: Record<string, unknown> = {}) =>
  okFixture('req_publish', {
    publicationId: 'pub_1',
    messageIds: ['m1'],
    subscriberTaskIds: ['t2', 't3'],
    ...overrides
  })

const checkpointFixture = (overrides: Record<string, unknown> = {}) =>
  okFixture('req_checkpoint', {
    entries: [],
    filteredMessageIds: [],
    timedOut: false,
    cancelled: false,
    ...overrides
  })

const ackFixture = (overrides: Record<string, unknown> = {}) =>
  okFixture('req_ack', { messageIds: ['m1'], duplicate: false, ...overrides })

describe('orchestration collaboration handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    restoreEnv('ORCA_TERMINAL_HANDLE', originalTerminalHandle)
    restoreEnv('ORCA_PANE_KEY', originalPaneKey)
    process.exitCode = 0
  })

  const paramsFor = (method: string): Record<string, unknown> =>
    callMock.mock.calls.find((call) => call[0] === method)?.[1] as Record<string, unknown>

  const optionsFor = (method: string): Record<string, unknown> | undefined =>
    callMock.mock.calls.find((call) => call[0] === method)?.[2] as
      | Record<string, unknown>
      | undefined

  const output = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n')

  describe('collaboration-publish', () => {
    it('maps topic, semantic type, default priority, empty body and env from into collaborationPublish', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, publishFixture())

      await main(
        [
          'orchestration',
          'collaboration-publish',
          '--topic',
          'topology',
          '--semantic-type',
          'proposal',
          '--body',
          ''
        ],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).not.toHaveBeenCalledWith('terminal.show', expect.anything())
      expect(paramsFor('orchestration.collaborationPublish')).toEqual({
        from: 'term_task',
        topic: 'topology',
        semanticType: 'proposal',
        priority: 'normal',
        body: ''
      })
      expect(output()).toBe('Published pub_1 to 2 subscriber(s).')
    })

    it('passes dispatch capability through RuntimeClient options', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, publishFixture())

      await main(
        [
          'orchestration',
          'collaboration-publish',
          '--topic',
          'topology',
          '--semantic-type',
          'proposal',
          '--body',
          'ship?',
          '--priority',
          'urgent',
          '--dispatch-capability',
          'dispatch.1'
        ],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      expect(paramsFor('orchestration.collaborationPublish')).toEqual(
        expect.objectContaining({ priority: 'urgent', body: 'ship?' })
      )
      expect(optionsFor('orchestration.collaborationPublish')).toEqual({
        orchestrationCapability: 'dispatch.1'
      })
    })

    it('maps --retry-request to orchestrationRequestId through callOrchestrationMutation', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, publishFixture())

      await main(
        [
          'orchestration',
          'collaboration-publish',
          '--topic',
          'topology',
          '--semantic-type',
          'proposal',
          '--body',
          'retry me',
          '--retry-request',
          'mutation_9'
        ],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      expect(optionsFor('orchestration.collaborationPublish')).toEqual({
        orchestrationRequestId: 'mutation_9'
      })
    })

    it('rejects an invalid priority before any RPC', async () => {
      await main(
        [
          'orchestration',
          'collaboration-publish',
          '--topic',
          'topology',
          '--semantic-type',
          'proposal',
          '--body',
          'x',
          '--priority',
          'bogus'
        ],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(1)
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        '--priority must be one of: normal, high, urgent'
      )
      expect(callMock).not.toHaveBeenCalledWith(
        'orchestration.collaborationPublish',
        expect.anything()
      )
    })
  })

  describe('collaboration-checkpoint', () => {
    it('maps limit, wait, timeout-ms, from and capability into collaborationCheckpoint', async () => {
      queueFixtures(
        callMock,
        checkpointFixture({
          entries: [
            {
              messageId: 'm1',
              topic: 'topology',
              semanticType: 'proposal',
              producerTaskId: 't1',
              priority: 'normal',
              body: 'payload'
            }
          ]
        })
      )

      await main(
        [
          'orchestration',
          'collaboration-checkpoint',
          '--limit',
          '7',
          '--wait',
          '--timeout-ms',
          '30000',
          '--from',
          'term_task',
          '--dispatch-capability',
          'dispatch.1'
        ],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(paramsFor('orchestration.collaborationCheckpoint')).toEqual({
        from: 'term_task',
        limit: 7,
        wait: true,
        timeoutMs: 30000
      })
      expect(optionsFor('orchestration.collaborationCheckpoint')).toEqual({
        orchestrationCapability: 'dispatch.1'
      })
    })

    it('omits wait and timeoutMs when not requested', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, checkpointFixture())

      await main(['orchestration', 'collaboration-checkpoint'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      expect(paramsFor('orchestration.collaborationCheckpoint')).toEqual({
        from: 'term_task',
        limit: undefined,
        wait: undefined,
        timeoutMs: undefined
      })
      expect(optionsFor('orchestration.collaborationCheckpoint')).toBeUndefined()
    })

    it('JSON-stringifies entry bodies so raw control characters are not emitted', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      const body = 'line1\u001b[31mred\nline2\tcol'
      queueFixtures(
        callMock,
        checkpointFixture({
          entries: [
            {
              messageId: 'm1',
              topic: 'topology',
              semanticType: 'proposal',
              producerTaskId: 't1',
              priority: 'normal',
              body
            }
          ]
        })
      )

      await main(['orchestration', 'collaboration-checkpoint'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      const text = output()
      expect(text).toContain('message m1 topology proposal normal producer=t1')
      expect(text).toContain('\\u001b')
      expect(text).toContain('red\\nline2')
      expect(text).toContain('line2\\tcol')
      expect(text).not.toContain('\u001b')
      expect(text).not.toContain('red\nline2')
    })

    it('distinguishes timedOut from cancelled empty checkpoints', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, checkpointFixture({ timedOut: true }))

      await main(['orchestration', 'collaboration-checkpoint'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      expect(output()).toBe('Timed out waiting for collaboration context.')

      callMock.mockReset()
      logSpy.mockClear()
      queueFixtures(callMock, checkpointFixture({ cancelled: true }))

      await main(['orchestration', 'collaboration-checkpoint'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      expect(output()).toBe('Collaboration checkpoint cancelled.')
    })
  })

  describe('collaboration-ack', () => {
    it('parses message-ids JSON array and maps it to collaborationAck', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, ackFixture({ messageIds: ['m1', 'm2'] }))

      await main(
        ['orchestration', 'collaboration-ack', '--message-ids', '["m1","m2"]'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(paramsFor('orchestration.collaborationAck')).toEqual({
        from: 'term_task',
        messageIds: ['m1', 'm2']
      })
      expect(output()).toBe('Acknowledged 2 collaboration message(s).')
    })

    it.each([
      ['malformed', 'not-json'],
      ['empty array', '[]'],
      ['non-string entries', '[1,2]'],
      ['over 100 entries', JSON.stringify(Array.from({ length: 101 }, (_, i) => `m${i}`))]
    ])('rejects %s message-ids before any RPC', async (_label, raw) => {
      await main(
        ['orchestration', 'collaboration-ack', '--message-ids', raw, '--from', 'term_task'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(1)
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        '--message-ids must be a JSON array of 1..100 non-empty strings.'
      )
      expect(callMock).not.toHaveBeenCalledWith('orchestration.collaborationAck', expect.anything())
    })

    it('appends replay to the text line when duplicate', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, ackFixture({ messageIds: ['m1'], duplicate: true }))

      await main(['orchestration', 'collaboration-ack', '--message-ids', '["m1"]'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      expect(output()).toBe('Acknowledged 1 collaboration message(s). (replay)')
    })

    it('JSON mode emits the standard printResult envelope', async () => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_task'
      queueFixtures(callMock, ackFixture({ messageIds: ['m1', 'm2'], duplicate: true }))

      await main(
        ['orchestration', 'collaboration-ack', '--message-ids', '["m1","m2"]', '--json'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(0)
      const parsed = JSON.parse(output()) as {
        id: string
        ok: boolean
        result: { messageIds: string[]; duplicate: boolean }
      }
      expect(parsed).toMatchObject({
        id: 'req_ack',
        ok: true,
        result: { messageIds: ['m1', 'm2'], duplicate: true }
      })
      expect(parsed.result.messageIds).toEqual(['m1', 'm2'])
    })
  })
})
