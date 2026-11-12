import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { answerDaemonControlRequest } from '../daemon-control-request'
import { withPreparedReply } from '../daemon-reply-obligation'
import type { DaemonRequest } from '../../protocol/daemon-rpc-contract'

type Write = { line: string; done: () => void }

function fakeSocket(opts: { destroyed?: boolean; throws?: boolean } = {}) {
  const writes: Write[] = []
  const socket = Object.assign(new EventEmitter(), {
    destroyed: opts.destroyed === true,
    write: (line: string, done: () => void) => {
      if (opts.throws) {
        throw new Error('write after end')
      }
      writes.push({ line, done })
      return true
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer uses only write, destroyed and close events.
  return { socket: socket as unknown as Socket, writes }
}

const request = (id = 'req-1'): DaemonRequest =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer reads only the id.
  ({ id, type: 'getSnapshot', payload: { sessionId: 's' } }) as DaemonRequest

describe('deep-history reply ownership at the outer writer', () => {
  it('writes the prepared line verbatim and releases only when the write settles', async () => {
    const { socket, writes } = fakeSocket()
    const release = vi.fn()
    const onReply = vi.fn()
    const line = '{"id":"req-1","ok":true,"payload":{"marker":"\\u001b[1mPREPARED"}}\n'
    await answerDaemonControlRequest(
      socket,
      request(),
      async () => withPreparedReply({ ignored: true }, { line, release }),
      onReply
    )

    expect(writes.map((write) => write.line)).toEqual([line])
    // A caller timeout while bytes are still buffered must not free them.
    expect(release).not.toHaveBeenCalled()
    writes[0]!.done()
    socket.emit('close')
    expect(release).toHaveBeenCalledTimes(1)
    expect(onReply).toHaveBeenCalledTimes(1)
  })

  it('releases once when the socket closes before the write settles', async () => {
    const { socket, writes } = fakeSocket()
    const release = vi.fn()
    await answerDaemonControlRequest(
      socket,
      request(),
      async () => withPreparedReply({}, { line: 'x\n', release }),
      () => {}
    )
    socket.emit('close')
    writes[0]!.done()

    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an already closed socket', { destroyed: true }, 'req-1'],
    ['a throwing write', { throws: true }, 'req-1'],
    ['a notification', {}, 'notify_1']
  ] as const)('releases %s without leaking the reply', async (_, opts, id) => {
    const { socket, writes } = fakeSocket(opts)
    const release = vi.fn()
    await answerDaemonControlRequest(
      socket,
      request(id),
      async () => withPreparedReply({}, { line: 'x\n', release }),
      () => {}
    )

    expect(release).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(0)
  })

  it('writes a failed read as an ordinary error and releases its consumer after the write', async () => {
    const { socket, writes } = fakeSocket()
    const release = vi.fn()
    await answerDaemonControlRequest(
      socket,
      request(),
      async () => {
        throw withPreparedReply(new Error('terminal_history_unavailable'), { release })
      },
      () => {}
    )

    expect(JSON.parse(writes[0]!.line)).toEqual({
      id: 'req-1',
      ok: false,
      error: 'terminal_history_unavailable'
    })
    expect(release).not.toHaveBeenCalled()
    writes[0]!.done()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
