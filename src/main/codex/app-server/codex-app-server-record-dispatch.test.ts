import { expect, it } from 'vitest'
import { createCodexAppServerRecordDispatcher } from './codex-app-server-record-dispatch'

it('ends the session with a named error when a notification is over the line limit', () => {
  const failures: Error[] = []
  const dispatcher = createCodexAppServerRecordDispatcher({
    handlers: {},
    writeResponse: () => {},
    onProtocolFailure: (error) => failures.push(error)
  })
  dispatcher.rejectOversized({
    kind: 'line-too-long',
    maxLineBytes: 128 * 2 ** 20,
    observedBytes: 128 * 2 ** 20 + 65_536,
    prefix: '{"method":"item/completed","params":{"threadId":"t"}'
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({
    name: 'CodexAppServerFrameSizeError',
    message: 'A Codex item/completed notification was over the 128 MB limit for one message'
  })
})

it('drops an oversized late reply to a request that timed out, leaving other requests alone', () => {
  const failures: Error[] = []
  const dispatcher = createCodexAppServerRecordDispatcher({
    handlers: {},
    writeResponse: () => {},
    onProtocolFailure: (error) => failures.push(error)
  })
  const rejected: Error[] = []
  const waiter = (method: string) => ({
    method,
    resolve: () => {},
    reject: (error: Error) => rejected.push(error),
    timer: undefined
  })
  // More timeouts than the dispatcher remembers by method.
  for (let id = 1; id <= 65; id++) {
    dispatcher.addPending(id, waiter('thread/read'))
    dispatcher.timeOutPending(id)
  }
  dispatcher.addPending(66, waiter('thread/resume'))
  dispatcher.rejectOversized({
    kind: 'line-too-long',
    maxLineBytes: 128 * 2 ** 20,
    observedBytes: 128 * 2 ** 20 + 65_536,
    prefix: '{"id":1,"result":{"thread":{}}'
  })
  expect(failures).toEqual([])
  expect(rejected).toEqual([])
})
