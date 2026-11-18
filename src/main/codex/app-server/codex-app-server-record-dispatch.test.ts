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
    observedBytes: 130 * 2 ** 20,
    prefix: '{"method":"item/completed","params":{"threadId":"t"}'
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({
    name: 'CodexAppServerFrameSizeError',
    message:
      'A Codex item/completed notification was at least 130 MB, over the 128 MB limit for one message'
  })
})
