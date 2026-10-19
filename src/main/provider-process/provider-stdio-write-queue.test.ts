import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ProviderStdioWriteQueue } from './provider-stdio-write-queue'

// An agent that stopped reading its stdin: the first line is handed over and never completes.
function stalledQueue() {
  const output = new Writable({ write() {} })
  const onFailure = vi.fn()
  const queue = new ProviderStdioWriteQueue(output, 1024, onFailure, {
    capacity: () => new Error('capacity'),
    closed: () => new Error('closed')
  })
  return { queue, onFailure }
}

describe('ProviderStdioWriteQueue aborts', () => {
  it('drops a line still waiting in the queue and rejects only its request', async () => {
    const { queue, onFailure } = stalledQueue()
    void queue.write('active\n')
    const waiting = new AbortController()
    const dropped = queue.write('waiting\n', waiting.signal)
    waiting.abort(new Error('timed out'))
    await expect(dropped).rejects.toThrow('timed out')
    // Nothing of it reached the agent, so the connection stays up for the next request.
    expect(onFailure).not.toHaveBeenCalled()
    void queue.write('next\n')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('closes the connection when the line being written times out, since it cannot be taken back', () => {
    const { queue, onFailure } = stalledQueue()
    const active = new AbortController()
    void queue.write('active\n', active.signal)
    active.abort(new Error('timed out'))
    // The stream owns the line, possibly partly on the pipe; leaving it would hold every later
    // write, a Stop included, behind a reader that stopped.
    expect(onFailure).toHaveBeenCalledWith(new Error('timed out'))
  })
})
