import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-transport-writer'

let mux: SshChannelMultiplexer
let receive: (data: Buffer) => void
let written: Buffer[]
let settlements: ((result: MultiplexerTransportWriteResult) => void)[]
let writeResult: boolean
let drainTransport: () => void
beforeEach(() => {
  vi.useFakeTimers()
  written = []
  settlements = []
  writeResult = true
  mux = new SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write: (data, settled) => {
      written.push(data)
      settlements.push(settled!)
      return writeResult
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {},
    onDrain: (callback) => {
      drainTransport = callback
    }
  })
})
afterEach(() => {
  mux.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const signal = () => new AbortController().signal
const respond = (id: number, result: unknown) =>
  receive(encodeJsonRpcFrame({ jsonrpc: '2.0', id, result }, id, 0))

it('blocks anonymous and replayed creation through a live provider catalog fence', async () => {
  const provider = new SshPtyProvider('target', mux, undefined, 1)
  await provider.fenceOutgoingCatalogCreation(signal())
  await provider.fenceOutgoingCatalogCreation(signal())
  await expect(provider.requestHostRpc('pty.spawn', {})).rejects.toThrow('catalog_preparing')
  await expect(
    provider.requestHostRpc('pty.spawn', { agentSessionCreateOperationId: 'a'.repeat(43) })
  ).rejects.toThrow('catalog_preparing')
  expect(written).toHaveLength(0)
  expect(mux.isDisposed()).toBe(false)
  provider.dispose()
})

it('waits for pre-gate creation responses and their transport writes', async () => {
  const create = mux.request('pty.spawn', {})
  let complete = false
  const drain = mux.drainPtyCatalogCreation(signal()).then(() => {
    complete = true
  })
  await expect(mux.request('pty.spawn', {})).rejects.toThrow('catalog_preparing')
  await vi.advanceTimersByTimeAsync(0)
  expect(complete).toBe(false)
  settlements[0]({ ok: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(complete).toBe(false)
  respond(1, { id: 'created-terminal' })
  await create
  await drain
  expect(complete).toBe(true)
})

it('retains earlier creation uncertainty after the request map empties', async () => {
  const create = mux.request('pty.spawn', {}, { timeoutMs: 10 }).catch((error) => error)
  settlements[0]({ ok: true })
  await vi.advanceTimersByTimeAsync(11)
  await create
  settlements[1]({ ok: true })
  await mux.waitForPendingOperations(signal())
  await expect(mux.drainPtyCatalogCreation(signal())).rejects.toThrow('creation_unverifiable')
  await expect(mux.drainPtyCatalogCreation(signal())).rejects.toThrow('creation_unverifiable')
  await expect(mux.request('pty.spawn', {})).rejects.toThrow('catalog_preparing')
  await mux.fencePtyControlsAndDrain('unrelated', signal())
})

it.each(['notify', 'notifyWithSettlement'] as const)(
  'does not treat unacknowledged creation as settled (%s)',
  async (method) => {
    if (method === 'notify') {
      mux.notify('pty.spawn', {})
    } else {
      mux.notifyWithSettlement('pty.spawn', {}, vi.fn())
    }
    settlements[0]({ ok: true })
    await expect(mux.drainPtyCatalogCreation(signal())).rejects.toThrow('creation_unverifiable')
  }
)

it('orders previously admitted input before prepare through the real provider and saturated mux', async () => {
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  const identity = {
    bridgeId: 'bridge',
    terminalId: 'terminal',
    incarnationId: 'incarnation',
    ownerLease: 'owner',
    sourceOwnerGeneration: 1,
    destinationRuntimeId: 'destination'
  }
  const provider = new SshPtyProvider('target', mux, undefined, 1)
  vi.spyOn(provider, 'getOwnershipTransferSourceIdentity').mockReturnValue(identity)
  writeResult = false
  provider.write('terminal', 'input-1')
  provider.write('terminal', 'input-2')
  const prepare = provider
    .drainOutgoingSourceControls({ identity, providerGeneration: 1, signal: signal() })
    .then(() => provider.requestHostRpc('pty.ownershipTransfer.prepare', { identity }))
  await expect(provider.writeWithSettlement('terminal', 'new input')).resolves.toEqual({
    outcome: 'refused',
    reason: 'write_gate_denied'
  })
  expect(written).toHaveLength(1)
  settlements[0]({ ok: true })
  writeResult = true
  drainTransport()
  expect(written).toHaveLength(2)
  settlements[1]({ ok: true })
  await vi.advanceTimersByTimeAsync(0)
  const frames = written.map((frame) => JSON.parse(frame.subarray(HEADER_LENGTH).toString()))
  expect(frames.map((frame) => frame.method)).toEqual([
    'pty.data',
    'pty.data',
    'pty.ownershipTransfer.prepare'
  ])
  expect(frames.slice(0, 2).map((frame) => frame.params.data)).toEqual(['input-1', 'input-2'])
  settlements[2]({ ok: true })
  respond(1, {})
  await prepare
  provider.dispose()
})

it.each(['response-first', 'write-first'])(
  'requires both transport and RPC settlement (%s)',
  async (order) => {
    const request = mux.request('pty.shutdown', { id: 'terminal' })
    const settled = vi.fn()
    const barrier = mux.waitForPendingOperations(signal()).then(settled)
    if (order === 'response-first') {
      respond(1, null)
    } else {
      settlements[0]({ ok: true })
    }
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    if (order === 'response-first') {
      settlements[0]({ ok: true })
    } else {
      respond(1, null)
    }
    await Promise.all([request, barrier])
    expect(settled).toHaveBeenCalledOnce()
  }
)

it('excludes requests admitted after the snapshot', async () => {
  const first = mux.request('pty.sendSignal', { id: 'first', signal: 'SIGINT' })
  const barrier = mux.waitForPendingOperations(signal())
  const later = mux.request('fs.stat', { path: '/later' })
  settlements[0]({ ok: true })
  respond(1, null)
  await Promise.all([first, barrier])
  settlements[1]({ ok: true })
  respond(2, {})
  await later
})

it('refuses a failed RPC instead of treating an empty pending map as successful drain', async () => {
  const request = mux.request('pty.clearBuffer', { id: 'terminal' }).catch((error) => error)
  settlements[0]({ ok: true })
  const barrier = mux.waitForPendingOperations(signal()).catch((error) => error)
  receive(
    encodeJsonRpcFrame(
      { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'host refused' } },
      1,
      0
    )
  )
  expect(await request).toBeInstanceOf(Error)
  expect(await barrier).toMatchObject({ message: 'host refused' })
})

it('refuses timed-out requests without asserting their host outcome', async () => {
  const request = mux
    .request('pty.shutdown', { id: 'terminal' }, { timeoutMs: 10 })
    .catch((error) => error)
  settlements[0]({ ok: true })
  const barrier = mux.waitForPendingOperations(signal()).catch((error) => error)
  await vi.advanceTimersByTimeAsync(11)
  expect(await request).toMatchObject({ code: 'SSH_MUX_REQUEST_TIMEOUT' })
  expect(await barrier).toMatchObject({ code: 'SSH_MUX_REQUEST_TIMEOUT' })
})

it('cancels an observer without canceling the RPC or another observer', async () => {
  const request = mux.request('pty.sendSignal', { id: 'terminal', signal: 'SIGINT' })
  const controller = new AbortController()
  const canceled = mux.waitForPendingOperations(controller.signal).catch((error) => error)
  const retained = mux.waitForPendingOperations(signal())
  controller.abort(new Error('observer canceled'))
  expect(await canceled).toMatchObject({ message: 'observer canceled' })
  expect(written).toHaveLength(1)
  expect(mux.isDisposed()).toBe(false)
  settlements[0]({ ok: true })
  respond(1, null)
  await Promise.all([retained, request])
})

it('includes response-processing failure in the captured request outcome', async () => {
  const request = mux
    .request(
      'pty.shutdown',
      {},
      {
        beforeResolve: () => {
          throw new Error('response stale')
        }
      }
    )
    .catch((error) => error)
  const barrier = mux.waitForPendingOperations(signal()).catch((error) => error)
  settlements[0]({ ok: true })
  respond(1, null)
  expect(await request).toBeInstanceOf(Error)
  expect(await barrier).toMatchObject({ message: 'response stale' })
})

it('cleans up a request that fails synchronously while encoding', async () => {
  const params: Record<string, unknown> = {}
  params.cycle = params
  await expect(mux.request('invalid', params)).rejects.toThrow()
  await mux.waitForPendingOperations(signal())
  expect(written).toEqual([])
})

it('refuses transport loss with frames and a request still pending', async () => {
  mux.notify('pty.data', { id: 'terminal', data: 'input' })
  const request = mux.request('pty.shutdown', {}).catch((error) => error)
  const barrier = mux.waitForPendingOperations(signal()).catch((error) => error)
  mux.dispose('connection_lost')
  expect(await request).toMatchObject({ code: 'CONNECTION_LOST' })
  expect(await barrier).toBeInstanceOf(Error)
})

it('closes new source mutations before waiting for older operations', async () => {
  mux.notify('pty.data', { id: 'terminal', data: 'before' })
  const drain = mux.fencePtyControlsAndDrain('terminal', signal())
  expect(() => mux.notify('pty.data', { id: 'terminal', data: 'after' })).toThrow('preparing')
  await expect(mux.request('pty.shutdown', { id: 'terminal' })).rejects.toThrow('preparing')
  const settled = vi.fn()
  mux.notifyWithSettlement('pty.data', { id: 'terminal', data: 'after' }, settled)
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'refused', reason: 'write_gate_denied' })
  )
  expect(written).toHaveLength(1)
  settlements[0]({ ok: true })
  await drain
  mux.notify('pty.data', { id: 'other', data: 'unrelated' })
  expect(written).toHaveLength(2)
})

it('retains earlier failed control evidence after the pending request map has emptied', async () => {
  const request = mux
    .request('pty.shutdown', { id: 'terminal' }, { timeoutMs: 10 })
    .catch((error) => error)
  settlements[0]({ ok: true })
  await vi.advanceTimersByTimeAsync(11)
  await request
  settlements[1]({ ok: true })
  await mux.waitForPendingOperations(signal())
  await expect(mux.fencePtyControlsAndDrain('terminal', signal())).rejects.toThrow(
    'outcome_unverifiable'
  )
  expect(() => mux.notify('pty.data', { id: 'terminal', data: 'after failed drain' })).toThrow(
    'preparing'
  )
  await expect(mux.request('pty.shutdown', { id: 'terminal' })).rejects.toThrow('preparing')
  await mux.fencePtyControlsAndDrain('unrelated', signal())
})

it('keeps admission closed when a pending control fails during drain', async () => {
  const request = mux.request('pty.sendSignal', { id: 'terminal' }).catch((error) => error)
  settlements[0]({ ok: true })
  const drain = mux.fencePtyControlsAndDrain('terminal', signal()).catch((error) => error)
  receive(
    encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'uncertain' } }, 1, 0)
  )
  await request
  expect(await drain).toBeInstanceOf(Error)
  expect(() => mux.notify('pty.resize', { id: 'terminal', cols: 80, rows: 24 })).toThrow(
    'preparing'
  )
  await expect(mux.fencePtyControlsAndDrain('terminal', signal())).rejects.toThrow(
    'outcome_unverifiable'
  )
})
