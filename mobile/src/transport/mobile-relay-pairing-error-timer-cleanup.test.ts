import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from './types'

type ChannelRecord = {
  options: { onAuthenticated(): void; onText(value: string): void; onError(error: Error): void }
  start: ReturnType<typeof vi.fn>
  sendText: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const observed = vi.hoisted(() => ({ channels: new Array<ChannelRecord>() }))
vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))
vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEV2PhysicalChannel: class {
    start = vi.fn()
    handleMessage = vi.fn(async () => {})
    sendText = vi.fn((_frame: string) => true)
    dispose = vi.fn()
    constructor(readonly options: ChannelRecord['options']) {
      observed.channels.push(this)
    }
  }
}))

import { connectMobileRelayForPairing, RelayOuterError } from './mobile-relay-physical-client'

class PairingTimerSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  send = vi.fn((_frame: string) => {})
  close = vi.fn(() => {})
}

function fixture() {
  const socket = new PairingTimerSocket()
  const logs: ConnectionLogEntry[] = []
  const client = connectMobileRelayForPairing({
    relay: {
      v: 1,
      directorUrl: 'https://relay.onorca.dev',
      cellUrl: 'https://relay-c1.onorca.dev',
      assignmentEpoch: 7,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
      inviteExpiresAt: Date.now() + 300_000,
      e2eeFraming: 2
    },
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    onLog: (entry) => logs.push(entry),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The observed socket implements every WebSocket member this client and mocked channel use.
    createSocket: () => socket as unknown as WebSocket
  })
  const channel = observed.channels.at(-1)
  if (!channel) {
    throw new Error('missing observed pairing channel')
  }
  return { client, socket, logs, channel }
}

async function authenticate(target: ReturnType<typeof fixture>): Promise<void> {
  target.socket.onmessage?.({
    data: JSON.stringify({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'invite',
      leaseExpiresAt: Date.now() + 60_000
    })
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(target.channel.start).toHaveBeenCalledOnce()
  target.channel.options.onAuthenticated()
}

function closedLogs(logs: ConnectionLogEntry[]): ConnectionLogEntry[] {
  return logs.filter((entry) => entry.message === 'Relay: pairing socket closed')
}

beforeEach(() => {
  observed.channels.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('closed relay pairing client error timer ownership', () => {
  it('keeps authentication waiter rejection and intentional-close log exact without a late alarm', async () => {
    const target = fixture()
    const first = target.client.sendRequest('first').catch((error: unknown) => error)
    const second = target.client.sendRequest('second').catch((error: unknown) => error)
    target.client.close()
    const failure = await first
    expect(failure).toEqual(new Error('relay pairing client closed'))
    expect(await second).toBe(failure)
    target.socket.onerror?.()
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'info', detail: 'relay-c1.onorca.dev' })
    ])
    expect(target.channel.dispose).toHaveBeenCalledOnce()
    expect(target.socket.close).toHaveBeenCalledOnce()
  })

  it('keeps the original error for every pending RPC and clears their timers before late errors', async () => {
    const target = fixture()
    await authenticate(target)
    const first = target.client.sendRequest('first').catch((error: unknown) => error)
    const second = target.client.sendRequest('second').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(2)
    const failure = new Error('channel failed')
    target.channel.options.onError(failure)
    expect(await first).toBe(failure)
    expect(await second).toBe(failure)
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'Error: channel failed' })
    ])
    expect(target.channel.dispose).toHaveBeenCalledOnce()
    expect(target.socket.close).toHaveBeenCalledOnce()
  })

  it.each(['intentional', 'channel', 'fallback'])(
    'starts no timer for reentrant socket.close errors during %s',
    async (mode) => {
      const target = fixture()
      const waiting = target.client.sendRequest('status.get').catch((error: unknown) => error)
      target.socket.close.mockImplementation(() => target.socket.onerror?.())
      const failure = new Error('channel failed')
      if (mode === 'intentional') {
        target.client.close()
        expect(await waiting).toEqual(new Error('relay pairing client closed'))
      } else if (mode === 'channel') {
        target.channel.options.onError(failure)
        expect(await waiting).toBe(failure)
      } else {
        target.socket.onerror?.()
        await vi.advanceTimersByTimeAsync(250)
        expect(await waiting).toEqual(new RelayOuterError(1006))
      }
      expect(vi.getTimerCount()).toBe(0)
      expect(closedLogs(target.logs)).toHaveLength(1)
      expect(target.channel.dispose).toHaveBeenCalledOnce()
      expect(target.socket.close).toHaveBeenCalledOnce()
    }
  )

  it('keeps a normal typed close rejection and log without a late alarm', async () => {
    const target = fixture()
    const waiting = target.client.sendRequest('status.get').catch((error: unknown) => error)
    target.socket.onclose?.({ code: 4409 })
    expect(await waiting).toEqual(new RelayOuterError(4409))
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'relay close code 4409' })
    ])
  })

  it('keeps a rejected hello error and log without a late alarm', async () => {
    const target = fixture()
    const waiting = target.client.sendRequest('status.get').catch((error: unknown) => error)
    target.socket.onmessage?.({
      data: JSON.stringify({ type: 'relay-hello', ok: false, code: 4404 })
    })
    expect(await waiting).toEqual(new RelayOuterError(4404))
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'relay close code 4404' })
    ])
    expect(target.channel.start).not.toHaveBeenCalled()
  })

  it('retains one live alarm and exactly the 250 ms missing-close grace', async () => {
    const target = fixture()
    const waiting = target.client.sendRequest('status.get').catch((error: unknown) => error)
    target.socket.onerror?.()
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(closedLogs(target.logs)).toHaveLength(0)
    expect(target.channel.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await waiting).toEqual(new RelayOuterError(1006))
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'relay close code 1006' })
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a typed close during the live error grace', async () => {
    const target = fixture()
    const waiting = target.client.sendRequest('status.get').catch((error: unknown) => error)
    target.socket.onerror?.()
    await vi.advanceTimersByTimeAsync(249)
    target.socket.onclose?.({ code: 4409 })
    expect(await waiting).toEqual(new RelayOuterError(4409))
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(closedLogs(target.logs)).toEqual([
      expect.objectContaining({ level: 'warn', detail: 'relay close code 4409' })
    ])
  })

  it('preserves an already settled RPC through explicit close and late errors', async () => {
    const target = fixture()
    await authenticate(target)
    const pending = target.client.sendRequest('status.get')
    await vi.advanceTimersByTimeAsync(0)
    target.channel.options.onText(JSON.stringify({ id: 'relay-pair-1', ok: true, result: 'done' }))
    const response = await pending
    expect(response).toEqual({ id: 'relay-pair-1', ok: true, result: 'done' })
    target.client.close()
    target.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(await pending).toBe(response)
    expect(closedLogs(target.logs)).toHaveLength(1)
    expect(target.channel.dispose).toHaveBeenCalledOnce()
  })

  it('lets a replacement own its single alarm and leaves none after its close', async () => {
    const old = fixture()
    const oldWaiting = old.client.sendRequest('old').catch((error: unknown) => error)
    old.client.close()
    expect(await oldWaiting).toEqual(new Error('relay pairing client closed'))
    const replacement = fixture()
    const waiting = replacement.client.sendRequest('new').catch((error: unknown) => error)
    old.socket.onerror?.()
    replacement.socket.onerror?.()
    expect(vi.getTimerCount()).toBe(1)
    replacement.socket.onclose?.({ code: 4409 })
    expect(await waiting).toEqual(new RelayOuterError(4409))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(closedLogs(old.logs)).toHaveLength(1)
    expect(closedLogs(replacement.logs)).toHaveLength(1)
    expect(old.channel.dispose).toHaveBeenCalledOnce()
    expect(replacement.channel.dispose).toHaveBeenCalledOnce()
  })
})
