import { afterEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-transport-writer'

const multiplexers: SshChannelMultiplexer[] = []
afterEach(() => {
  for (const mux of multiplexers.splice(0)) {
    mux.dispose()
  }
})

function fixture(callbackCapable = true) {
  let receive = (_bytes: Buffer): void => {}
  let seq = 0
  let autoSettle = true
  const writes: {
    message: Record<string, unknown>
    settle: (result: MultiplexerTransportWriteResult) => void
  }[] = []
  const mux = new SshChannelMultiplexer({
    supportsWriteSettlement: callbackCapable,
    write: (bytes, settle) => {
      writes.push({
        message: JSON.parse(bytes.subarray(HEADER_LENGTH).toString()),
        settle: settle!
      })
      if (autoSettle) {
        settle?.({ ok: true })
      }
      return true
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {}
  })
  multiplexers.push(mux)
  const respond = (index: number, error?: string, result: unknown = { prepared: true }) =>
    receive(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: writes[index].message.id as number,
          ...(error ? { error: { code: -32000, message: error } } : { result })
        },
        ++seq,
        0
      )
    )
  const request = (
    method = 'relay.reset',
    hook: (value: unknown) => void = () => mux.assertRelayResetAcknowledgmentDrained(),
    params?: Record<string, unknown>
  ) => {
    const index = writes.length
    const pending = mux.request(method, params, { beforeResolve: hook })
    void pending.catch(() => {})
    return {
      pending,
      respond: (error?: string) => respond(index, error),
      respondResult: (value: unknown) => respond(index, undefined, value),
      index
    }
  }
  return {
    mux,
    writes,
    request,
    pause: () => {
      autoSettle = false
    },
    incoming: () =>
      receive(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 900, method: 'remote.work' }, ++seq, 0))
  }
}

async function fence(f: ReturnType<typeof fixture>) {
  f.mux.fenceForRelayReset()
  await f.mux.waitForRelayResetDrain(new AbortController().signal)
}

it.each(['relay.reset', 'relay.recoverPreparedReset'])(
  'allows only exact %s beforeResolve token',
  async (method) => {
    const f = fixture()
    await fence(f)
    expect(() => f.mux.assertRelayResetAcknowledgmentDrained()).toThrow('context_unproven')
    const request = f.request(method)
    request.respond()
    await expect(request.pending).resolves.toEqual({ prepared: true })
    expect(() => f.mux.assertRelayResetAcknowledgmentDrained()).toThrow('context_unproven')
  }
)

it('refuses an unfenced reset response and an unrelated response hook', async () => {
  const f = fixture()
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('context_unproven')
  await fence(f)
  const status = f.request('relay.status')
  status.respond()
  await expect(status.pending).rejects.toThrow('context_unproven')
})

it('rejects legacy write acceptance without physical callback support', async () => {
  const f = fixture(false)
  await fence(f)
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('write_settlement_required')
})

it('refuses acknowledgment before its own physical write callback settles', async () => {
  const f = fixture()
  await fence(f)
  f.pause()
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('settlement_pending')
  f.writes[reset.index].settle({ ok: true })
})

it('does not exempt an unrelated outstanding request', async () => {
  const f = fixture()
  await fence(f)
  const status = f.request('relay.status', () => {})
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('settlement_pending')
  status.respond()
  await status.pending
})

it('retains outgoing failure after the failed request disappears', async () => {
  const f = fixture()
  await fence(f)
  const status = f.request('relay.status', () => {})
  status.respond('earlier request failed')
  await expect(status.pending).rejects.toThrow('earlier request failed')
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('earlier request failed')
})

it('requires completed incoming work as well as an empty writer', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.mux.onRequest('remote.work', () => work.promise)
  f.incoming()
  f.mux.fenceForRelayReset()
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('incoming_drain_unconfirmed')
  work.resolve()
  await vi.waitFor(() => expect(f.writes.length).toBe(2))
})

it('requires incoming response physical settlement even after handler completion', async () => {
  const f = fixture()
  f.pause()
  f.mux.onRequest('remote.work', async () => null)
  f.incoming()
  await vi.waitFor(() => expect(f.writes.length).toBe(1))
  f.mux.fenceForRelayReset()
  const reset = f.request()
  f.writes[reset.index].settle({ ok: true })
  reset.respond()
  await expect(reset.pending).rejects.toThrow('settlement_pending')
  f.writes[0].settle({ ok: true })
})

it('retains incoming failure after successful physical response publication', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.mux.onRequest('remote.work', () => work.promise)
  f.incoming()
  f.mux.fenceForRelayReset()
  work.reject(new Error('incoming failed'))
  await expect(f.mux.waitForRelayResetDrain(new AbortController().signal)).rejects.toThrow(
    'incoming failed'
  )
  const reset = f.request()
  reset.respond()
  await expect(reset.pending).rejects.toThrow('incoming failed')
})

it('does not leak exact callback authority into nested unrelated response hooks', async () => {
  const f = fixture()
  await fence(f)
  let nested: ReturnType<typeof f.request>
  const reset = f.request('relay.reset', () => {
    nested = f.request('relay.status')
    nested.respond()
  })
  reset.respond()
  await reset.pending
  await expect(nested!.pending).rejects.toThrow('context_unproven')
  expect(() => f.mux.assertRelayResetAcknowledgmentDrained()).toThrow('context_unproven')
})

const resetIdentity = {
  version: 1 as const,
  operationId: 'reset-op',
  runtimeIncarnation: 'daemon',
  ownerGeneration: 7,
  ownerLease: 'owner-lease'
}
const resetAck = {
  version: 1,
  operationId: 'reset-op',
  runtimeIncarnation: 'daemon',
  prepared: true
}

it.each(['relay.reset', 'relay.recoverPreparedReset'])(
  'binds %s acknowledgment to frozen issued identity',
  async (method) => {
    const f = fixture()
    await fence(f)
    const params = { ...resetIdentity }
    const request = f.request(
      method,
      () => f.mux.assertRelayResetAcknowledgmentDrained(resetIdentity),
      params
    )
    params.operationId = 'changed after send'
    params.ownerLease = 'changed lease'
    request.respondResult(resetAck)
    await expect(request.pending).resolves.toEqual(resetAck)
    expect(() => f.mux.assertRelayResetAcknowledgmentDrained(resetIdentity)).toThrow(
      'context_unproven'
    )
  }
)

it.each([
  { operationId: 'wrong' },
  { ownerGeneration: 8 },
  { ownerLease: 'wrong' },
  { runtimeIncarnation: 'wrong' }
])('rejects wrong expected reset identity %j', async (different) => {
  const f = fixture()
  await fence(f)
  const request = f.request(
    'relay.reset',
    () => f.mux.assertRelayResetAcknowledgmentDrained({ ...resetIdentity, ...different }),
    resetIdentity
  )
  request.respondResult(resetAck)
  await expect(request.pending).rejects.toThrow('request_mismatch')
})

it.each([
  { prepared: false },
  { operationId: 'wrong' },
  { runtimeIncarnation: 'wrong' },
  { version: 2 }
])('rejects invalid actual acknowledgment %j', async (different) => {
  const f = fixture()
  await fence(f)
  const request = f.request(
    'relay.reset',
    () => f.mux.assertRelayResetAcknowledgmentDrained(resetIdentity),
    resetIdentity
  )
  request.respondResult({ ...resetAck, ...different })
  await expect(request.pending).rejects.toThrow('acknowledgment_invalid')
})

it('does not let a hook rewrite a negative acknowledgment into proof', async () => {
  const f = fixture()
  await fence(f)
  const request = f.request(
    'relay.reset',
    (value) => {
      Object.assign(value!, resetAck)
      f.mux.assertRelayResetAcknowledgmentDrained(resetIdentity)
    },
    resetIdentity
  )
  request.respondResult({ ...resetAck, prepared: false })
  await expect(request.pending).rejects.toThrow('acknowledgment_invalid')
})

it('refuses expected proof for a malformed issued request', async () => {
  const f = fixture()
  await fence(f)
  const request = f.request(
    'relay.reset',
    () => f.mux.assertRelayResetAcknowledgmentDrained(resetIdentity),
    { ...resetIdentity, ownerGeneration: 0 }
  )
  request.respondResult(resetAck)
  await expect(request.pending).rejects.toThrow('request_mismatch')
})
