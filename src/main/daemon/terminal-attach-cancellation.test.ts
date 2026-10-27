import { describe, expect, it } from 'vitest'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'

describe('terminal attach cancellation', () => {
  it('preserves operation-first ordering when settlement and abort share a turn', async () => {
    const controller = new AbortController()
    const operation = Promise.withResolvers<string>()
    const waiting = waitForTerminalAttachOperation(
      operation.promise,
      controller.signal,
      'session-3'
    )
    operation.resolve('ready')
    controller.abort()
    await expect(waiting).resolves.toBe('ready')
  })
})
