import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { waitForChannelClose, waitForProcess } from './system-ssh-operation-lifecycle'
import { SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES } from './system-ssh-output-tail'

function createProcess(): EventEmitter & {
  stderr: EventEmitter
} {
  return Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
}

function createChannel(): EventEmitter & {
  stderr: EventEmitter
} {
  return Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
}

describe('system SSH operation output capture', () => {
  it('returns a bounded stderr tail for successful child processes', async () => {
    const process = createProcess()
    const result = waitForProcess(process as never, 'test process')

    process.stderr.emit(
      'data',
      Buffer.from(`HEAD${'x'.repeat(SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES)}TAIL`)
    )
    process.emit('close', 0)

    await expect(result).resolves.toMatchObject({
      label: 'test process',
      stderr: expect.stringContaining('TAIL')
    })
    expect((await result).stderr).not.toContain('HEAD')
  })

  it('uses the bounded stderr tail in channel failure diagnostics', async () => {
    const channel = createChannel()
    const result = waitForChannelClose(channel as never, 'test channel')

    channel.stderr.emit(
      'data',
      Buffer.from(`HEAD${'x'.repeat(SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES)}TAIL`)
    )
    channel.emit('close', 1, null)

    await expect(result).rejects.toThrow('TAIL')
    await expect(result).rejects.not.toThrow('HEAD')
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })
})
