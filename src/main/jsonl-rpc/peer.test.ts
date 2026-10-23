import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcPeer, type JsonlRpcPeerHandlers } from './peer'
import type { JsonlRpcPeerOptions } from './peer-limits'

const peers: JsonlRpcPeer[] = []
function fixture(
  handlers: JsonlRpcPeerHandlers = {},
  options: JsonlRpcPeerOptions = {},
  output = new PassThrough()
) {
  const input = new PassThrough()
  const peer = new JsonlRpcPeer(input, output, handlers, options)
  peers.push(peer)
  const reply = (record: unknown): void => {
    input.write(`${JSON.stringify(record)}\n`)
  }
  return { input, output, peer, reply }
}
afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close()
  }
  vi.useRealTimers()
})

describe('JSON-lines RPC peer', () => {
  it('correlates control replies and preserves unknown event fields', async () => {
    const onRecord = vi.fn()
    const { peer, output, reply } = fixture({ onRecord })
    const pending = peer.request('get_state')
    expect(JSON.parse(output.read().toString())).toEqual({ type: 'get_state', id: 'orca-1' })
    reply({ type: 'agent_start', future: { enabled: true } })
    reply({
      type: 'response',
      id: 'orca-1',
      command: 'get_state',
      success: true,
      data: { isStreaming: false }
    })
    expect(await pending).toEqual({ isStreaming: false })
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({
      type: 'agent_start',
      future: { enabled: true }
    })
  })

  it('frames only on LF, preserving Unicode separators and split UTF-8 code points', () => {
    const onRecord = vi.fn()
    const { input } = fixture({ onRecord })
    const bytes = Buffer.from('{"type":"message_update","text":"a\u2028b\u2029c😀"}\r\n')
    const split = bytes.indexOf(Buffer.from('😀')) + 2
    input.write(bytes.subarray(0, split))
    expect(onRecord).not.toHaveBeenCalled()
    input.write(bytes.subarray(split))
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({
      type: 'message_update',
      text: 'a\u2028b\u2029c😀'
    })
  })

  it('pauses within a burst and preserves queued records and a partial suffix across repeated pauses', async () => {
    const records: unknown[] = []
    const { peer, input } = fixture({
      onRecord: (record) => {
        records.push(record)
        peer.pauseReading()
      }
    })
    input.write('{"type":"first"}\n{"type":"second"}\n{"type":"thi')
    expect(records).toEqual([{ type: 'first' }])
    input.write('rd"}\n{"type":"fourth"}\n')
    peer.resumeReading()
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }])
    peer.resumeReading()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }, { type: 'third' }])
    peer.resumeReading()
    expect(records).toEqual([
      { type: 'first' },
      { type: 'second' },
      { type: 'third' },
      { type: 'fourth' }
    ])
  })

  it('ignores non-JSON output and routes id-less acknowledgements and dialogs', async () => {
    const onRecord = vi.fn()
    const onDiagnostic = vi.fn()
    const { peer, input, output, reply } = fixture({ onRecord, onDiagnostic })
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    input.write('extension banner\n\n')
    await peer.send({ type: 'prompt', message: '/ask' })
    reply({ type: 'extension_ui_request', id: 'dialog-1', method: 'input', title: 'Answer' })
    await peer.send({ type: 'extension_ui_response', id: 'dialog-1', value: '' })
    reply({ type: 'response', command: 'prompt', success: true })
    expect(onRecord.mock.calls.map(([record]) => record.type)).toEqual([
      'extension_ui_request',
      'response'
    ])
    expect(writes.join('')).toContain('"value":""')
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith('Ignored non-JSON agent output')
  })

  it('does not time out prompts waiting for slash expansion, but bounds control requests', async () => {
    vi.useFakeTimers()
    const { peer, reply } = fixture({}, { requestTimeoutMs: 100 })
    const prompt = peer.request('prompt', { message: '/ask' }, { timeoutMs: null })
    const control = expect(peer.request('get_state')).rejects.toThrow('get_state in time')
    await vi.advanceTimersByTimeAsync(1_000)
    await control
    reply({ type: 'response', id: 'orca-1', command: 'prompt', success: true })
    await expect(prompt).resolves.toBeUndefined()
    const bounded = expect(peer.request('prompt', {}, { timeoutMs: 10 })).rejects.toThrow('in time')
    await vi.advanceTimersByTimeAsync(10)
    await bounded
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { type: 'response', command: 'wrong', success: true },
    { type: 'response', command: 'prompt', success: 'yes' },
    { type: 'reponse', command: 'prompt', success: true },
    { type: 4 }
  ])('rejects malformed identified replies without stranding a prompt: %j', async (record) => {
    const { peer, reply } = fixture()
    const pending = expect(peer.request('prompt')).rejects.toThrow('Invalid agent RPC response')
    reply({ ...record, id: 'orca-1' })
    await pending
  })

  it('ignores unsolicited replies and preserves structured command errors', async () => {
    const onRecord = vi.fn()
    const { peer, reply } = fixture({ onRecord })
    const pending = expect(peer.request('get_state')).rejects.toThrow(
      'No API key found for provider'
    )
    reply({ type: 'response', id: 'other', command: 'get_state', success: true })
    reply({
      type: 'response',
      id: 'orca-1',
      command: 'get_state',
      success: false,
      error: 'No API key found for provider'
    })
    await pending
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('closes on oversized records, with bounded diagnostics and no later dispatch', async () => {
    const onRecord = vi.fn()
    const { peer, input, reply } = fixture({ onRecord }, { maxLineBytes: 64 })
    const pending = expect(peer.request('get_state')).rejects.toThrow('size limit')
    input.write(`{"type":"secret","text":"${'x'.repeat(100)}`)
    reply({ type: 'agent_settled' })
    await pending
    expect(peer.closed).toBe(true)
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('fails only an opted-in read whose reply is oversized, then keeps the stream', async () => {
    const onRecord = vi.fn()
    const { peer, input, reply } = fixture({ onRecord }, { maxLineBytes: 128 })
    const big = { id: 'orca-optional-1', type: 'response', command: 'get_entries', success: true }
    const entries = peer.request('get_entries', {}, { oversizedReply: 'reject' })
    input.write(`${JSON.stringify({ ...big, data: { entries: ['x'.repeat(300)] } })}\n`)
    await expect(entries).rejects.toThrow('exceeded 128 bytes')
    reply({ type: 'agent_settled' })
    const state = peer.request('get_state')
    reply({ type: 'response', id: 'orca-1', command: 'get_state', success: true, data: {} })
    expect(await state).toEqual({})
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({ type: 'agent_settled' })
    // A read that did not opt in still ends the stream.
    const plain = expect(peer.request('get_entries')).rejects.toThrow('size limit')
    input.write(`${JSON.stringify({ ...big, id: 'orca-2', data: 'y'.repeat(300) })}\n`)
    await plain
    expect(peer.closed).toBe(true)
  })

  it('survives a late oversized optional reply after timeout and permits another read', async () => {
    vi.useFakeTimers()
    const onRecord = vi.fn()
    const { peer, input, output, reply } = fixture({ onRecord }, { maxLineBytes: 128 })
    const expired = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject', timeoutMs: 10 })
    ).rejects.toThrow('in time')
    expect(JSON.parse(output.read().toString()).id).toBe('orca-optional-1')
    await vi.advanceTimersByTimeAsync(10)
    await expired
    const state = peer.request('get_state')
    input.write(
      '{"id":"orca-optional-1","type":"response","command":"get_entries","success":true,"data":"'
    )
    input.write('x'.repeat(300))
    input.write('"}\n')
    reply({ id: 'orca-1', type: 'response', command: 'get_state', success: true, data: {} })
    reply({ type: 'agent_settled' })
    await expect(state).resolves.toEqual({})
    const next = peer.request('get_entries', {}, { oversizedReply: 'reject' })
    reply({
      id: 'orca-optional-2',
      type: 'response',
      command: 'get_entries',
      success: true,
      data: []
    })
    await expect(next).resolves.toEqual([])
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({ type: 'agent_settled' })
    expect(peer.closed).toBe(false)
  })

  it.each([undefined, 'different_command'])(
    'uses local context for oversized optional replies with command %s',
    async (command) => {
      const { peer, input } = fixture({}, { maxLineBytes: 128 })
      const pending = expect(
        peer.request('get_entries', {}, { oversizedReply: 'reject' })
      ).rejects.toThrow('reply to get_entries exceeded 128 bytes')
      input.write(
        `${JSON.stringify({ id: 'orca-optional-1', type: 'response', command, data: 'x'.repeat(300) })}\n`
      )
      await pending
      expect(peer.closed).toBe(false)
    }
  )

  it.each([
    ['orca-optional-2', 'response'],
    ['orca-optional-0', 'response'],
    ['orca-optional-01', 'response'],
    ['orca-optional-9007199254740992', 'response'],
    ['orca-1', 'response'],
    ['foreign', 'response'],
    ['orca-optional-1', 'agent_end']
  ])('closes on an oversized record without issued optional ownership: %s %s', async (id, type) => {
    const { peer, input } = fixture({}, { maxLineBytes: 128 })
    const pending = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject' })
    ).rejects.toThrow('size limit')
    input.write(`${JSON.stringify({ id, type, data: 'x'.repeat(300) })}\n`)
    await pending
    expect(peer.closed).toBe(true)
  })

  it('closes when the response type has no structural field boundary', async () => {
    const { peer, input } = fixture({}, { maxLineBytes: 128 })
    const pending = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject' })
    ).rejects.toThrow('size limit')
    input.write(`{"id":"orca-optional-1","type":"response"garbage${'x'.repeat(300)}`)
    await pending
    expect(peer.closed).toBe(true)
  })

  it('keeps required replies and queued events around an oversized paused optional suffix', async () => {
    const records: unknown[] = []
    const { peer, input } = fixture(
      {
        onRecord: (record) => {
          records.push(record)
          if (record.type === 'first' || record.type === 'second') {
            peer.pauseReading()
          }
        }
      },
      { maxLineBytes: 256 }
    )
    const optional = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject' })
    ).rejects.toThrow('exceeded 256 bytes')
    const state = peer.request('get_state')
    // Already-read bytes can arrive within a burst after the consumer pauses.
    input.emit(
      'data',
      '{"type":"first"}\n{"type":"second"}\n{"id":"orca-1","type":"response","command":"get_state","success":true,"data":{}}\n{"id":"orca-optional-1","type":"response","data":"'
    )
    input.emit('data', 'x'.repeat(70_000))
    await optional
    peer.resumeReading()
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }])
    peer.resumeReading()
    await expect(state).resolves.toEqual({})
    input.emit('data', 'remaining optional bytes\n')
    input.emit('data', '{"type":"agent_settled"}\n')
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }, { type: 'agent_settled' }])
    expect(peer.closed).toBe(false)
  })

  it('closes on complete-queue loss even if the omitted batch begins with an optional reply', async () => {
    const { peer, input } = fixture({ onRecord: () => peer.pauseReading() }, { maxLineBytes: 256 })
    const pending = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject' })
    ).rejects.toThrow('size limit')
    input.emit('data', '{"type":"first"}\n{"type":"queued"}\n')
    const optional = '{"id":"orca-optional-1","type":"response","data":"'
    input.emit(
      'data',
      `${optional}${'x'.repeat(64 * 1024 * 1024)}"}\n{"type":"tool_execution_end"}\n`
    )
    await pending
    expect(peer.closed).toBe(true)
  })

  it('enforces pending capacity, and releases it after timeout and invalid response', async () => {
    vi.useFakeTimers()
    const { peer, reply } = fixture({}, { maxPendingRequests: 1, requestTimeoutMs: 10 })
    const first = expect(peer.request('get_state')).rejects.toThrow('in time')
    await expect(peer.request('get_state')).rejects.toThrow('capacity')
    await vi.advanceTimersByTimeAsync(10)
    await first
    const second = peer.request('get_state')
    reply({ type: 'response', id: 'orca-2', command: 'get_state', success: true })
    await second
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles all requests and detaches listeners on EOF, and isolates close observers', async () => {
    const { peer, input, output } = fixture({
      onClose: () => {
        throw new Error('observer')
      }
    })
    const pending = expect(peer.request('prompt')).rejects.toThrow('stream closed')
    input.emit('end')
    input.emit('close')
    await pending
    expect(input.listenerCount('data')).toBe(0)
    expect(output.listenerCount('drain')).toBe(0)
    await expect(peer.send({ type: 'abort' })).rejects.toThrow('stream closed')
  })

  it('rejects future writes after a broken pipe and consumes delayed stream errors', async () => {
    const output = new Writable({
      autoDestroy: false,
      write(_data, _encoding, callback) {
        callback(new Error('broken pipe'))
      }
    })
    const input = new PassThrough()
    const peer = new JsonlRpcPeer(input, output)
    peers.push(peer)
    await expect(peer.send({ type: 'abort' })).rejects.toThrow('broken pipe')
    await expect(peer.request('prompt')).rejects.toThrow('broken pipe')
    expect(() => output.emit('error', new Error('late error'))).not.toThrow()
  })

  it('closes a stalled active control write on timeout so later aborts cannot wait on it', async () => {
    vi.useFakeTimers()
    const output = new Writable({ write() {} })
    const peer = new JsonlRpcPeer(new PassThrough(), output, {}, { requestTimeoutMs: 10 })
    peers.push(peer)
    const pending = expect(peer.request('get_state')).rejects.toThrow('in time')
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(peer.closed).toBe(true)
    await expect(peer.send({ type: 'abort' })).rejects.toThrow('in time')
  })

  it('rejects invalid limits before installing stream listeners', () => {
    const input = new PassThrough()
    expect(() => new JsonlRpcPeer(input, new PassThrough(), {}, { maxLineBytes: 0 })).toThrow(
      'positive finite integers'
    )
    expect(input.listenerCount('data')).toBe(0)
  })
})
