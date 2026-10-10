import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'
import { AiVaultServiceTestChild } from '../main/ai-vault/session-scanner-service-test-child'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import type { RelayAiVaultServiceChildMessage } from './ai-vault-service-protocol'
import type { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'

const scan = vi.fn<typeof scanRemoteAiVaultSessions>()
const disposeProvider = vi.fn<() => void>()

const result = { sessions: [], issues: [], scannedAt: '2026-10-02T13:00:00.000Z' }
let outbound: RelayAiVaultServiceChildMessage[] = []
let frames: RelayAiVaultServiceChildMessage[] = []
let restoreProcess = (): void => undefined
let client: RelayAiVaultServiceClient | undefined

class BridgeChild extends AiVaultServiceTestChild {
  override send(message: unknown, callback?: (error: Error | null) => void): boolean {
    super.send(message, callback)
    process.emit('message', message)
    return true
  }
}

function deliver(child: BridgeChild): void {
  const message = outbound.shift()
  if (!message) {
    throw new Error('Expected one complete service reply in transit')
  }
  child.emit('message', message)
}

async function turn(): Promise<void> {
  await setImmediate()
}

function createClient(): BridgeChild {
  const child = new BridgeChild()
  client = new RelayAiVaultServiceClient({
    processFactory: () => child.asChildProcess(),
    init: { remoteHome: '/home/ada', hostPlatform: getRemoteHostPlatform('linux-x64') }
  })
  return child
}

function currentClient(): RelayAiVaultServiceClient {
  if (!client) {
    throw new Error('Expected the owned service client')
  }
  return client
}

async function close(child: BridgeChild): Promise<void> {
  const disposed = client?.dispose()
  await turn()
  child.emit('exit', 0)
  await disposed
  expect(disposeProvider).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  client = undefined
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  scan.mockReset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  outbound = []
  frames = []
  scan.mockResolvedValue(result)
  const send = Object.getOwnPropertyDescriptor(process, 'send')
  const disconnect = Object.getOwnPropertyDescriptor(process, 'disconnect')
  const messages = new Set(process.listeners('message'))
  const disconnects = new Set(process.listeners('disconnect'))
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (message: RelayAiVaultServiceChildMessage) => {
      outbound.push(message)
      frames.push(message)
      return true
    }
  })
  Object.defineProperty(process, 'disconnect', { configurable: true, value: vi.fn() })
  restoreProcess = () => {
    for (const listener of process.listeners('message')) {
      if (!messages.has(listener)) {
        process.removeListener('message', listener)
      }
    }
    for (const listener of process.listeners('disconnect')) {
      if (!disconnects.has(listener)) {
        process.removeListener('disconnect', listener)
      }
    }
    if (send) {
      Object.defineProperty(process, 'send', send)
    } else {
      delete process.send
    }
    if (disconnect) {
      Object.defineProperty(process, 'disconnect', disconnect)
    } else {
      delete process.disconnect
    }
  }
  const scanner = await import('../main/ai-vault/remote-session-scanner')
  vi.spyOn(scanner, 'scanRemoteAiVaultSessions').mockImplementation(scan)
  const titles = await import('../main/ai-vault/session-title-file-reader')
  vi.spyOn(titles, 'readAiVaultSessionTitlesFromFiles').mockResolvedValue({ titles: [] })
  const filesystem = await import('./ai-vault-service-filesystem')
  const createProvider = filesystem.createRelayAiVaultFilesystemProvider
  vi.spyOn(filesystem, 'createRelayAiVaultFilesystemProvider').mockImplementation((options) => {
    const provider = createProvider(options)
    const dispose = provider.dispose
    vi.spyOn(provider, 'dispose').mockImplementation(() => {
      disposeProvider()
      dispose()
    })
    return provider
  })
  await import('./ai-vault-service-entry')
})

afterEach(async () => {
  process.emit('message', { type: 'shutdown' })
  await turn()
  restoreProcess()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('actual parent cancellation during completed-response transit retains zero completed IDs', async () => {
  const child = createClient()
  const errors: unknown[] = []
  const retained: Set<unknown>[] = []
  const counts: number[] = []
  const warm = Promise.withResolvers<typeof result>()
  scan.mockImplementationOnce(() => warm.promise)
  const warmController = new AbortController()
  const warmResponse = currentClient()
    .listSessions({}, warmController.signal)
    .catch((error: unknown) => error)
  deliver(child)
  await turn()
  const warmAdd = vi.spyOn(Set.prototype, 'add')
  try {
    warmController.abort()
    const callIndex = warmAdd.mock.calls.findIndex(([value]) => value === 1)
    const owned = warmAdd.mock.contexts[callIndex]
    if (!(owned instanceof Set)) {
      throw new Error('Expected the actual native cancellation set for the admitted warm request')
    }
    retained.push(owned)
  } finally {
    warmAdd.mockRestore()
  }
  errors.push(await warmResponse)
  warm.resolve(result)
  await turn()
  deliver(child)
  await turn()
  expect(retained[0]?.size).toBe(0)
  for (let index = 0; index < 64; index++) {
    const id = index + 2
    if (index % 3 !== 2) {
      scan.mockImplementationOnce(async () => {
        if (index % 3 === 1) {
          throw new Error(`scan failure ${id}`)
        }
        return result
      })
    }
    const controller = new AbortController()
    const response = (
      index % 3 === 2
        ? currentClient().resolveSessionTitles([], controller.signal)
        : currentClient().listSessions({}, controller.signal)
    ).catch((error: unknown) => error)
    await turn()
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toEqual(
      index % 3 === 2
        ? { type: 'result', id, operation: 'titles', value: { titles: [] } }
        : index % 3 === 1
          ? { type: 'error', id, message: `scan failure ${id}` }
          : { type: 'result', id, operation: 'list', value: result }
    )
    const add = vi.spyOn(Set.prototype, 'add')
    try {
      controller.abort()
      const matching = add.mock.calls.flatMap(([value], callIndex) =>
        value === id ? [callIndex] : []
      )
      counts.push(matching.length)
      for (const callIndex of matching) {
        const owned = add.mock.contexts[callIndex]
        if (!(owned instanceof Set)) {
          throw new Error('Expected the actual native cancellation set')
        }
        retained.push(owned)
      }
    } finally {
      add.mockRestore()
    }
    errors.push(await response)
    deliver(child)
    await turn()
  }
  expect(
    errors.every(
      (error) =>
        error instanceof Error &&
        error.name === 'AbortError' &&
        error.message === 'The operation was aborted.'
    )
  ).toBe(true)
  expect(scan).toHaveBeenCalledTimes(44)
  expect(
    child.sent.filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'cancel'
    )
  ).toEqual(Array.from({ length: 65 }, (_, index) => ({ type: 'cancel', id: index + 1 })))
  const sizes = [...new Set(retained)].map((owned) => owned.size)
  await close(child)
  expect(frames).toEqual([
    { type: 'ready', protocol: 1, pid: process.pid },
    { type: 'result', id: 1, operation: 'list', value: result },
    ...Array.from({ length: 64 }, (_, index) => {
      const id = index + 2
      return index % 3 === 2
        ? { type: 'result', id, operation: 'titles', value: { titles: [] } }
        : index % 3 === 1
          ? { type: 'error', id, message: `scan failure ${id}` }
          : { type: 'result', id, operation: 'list', value: result }
    })
  ])
  expect(counts).toEqual(Array(64).fill(0))
  expect(sizes).toEqual([0])
})

it('an admitted active cancellation still aborts its exact scanner signal', async () => {
  const child = createClient()
  const pending = Promise.withResolvers<typeof result>()
  let signal: AbortSignal | undefined
  scan.mockImplementationOnce((options) => {
    signal = options.signal
    return pending.promise
  })
  const controller = new AbortController()
  const response = currentClient()
    .listSessions({}, controller.signal)
    .catch((error: unknown) => error)
  deliver(child)
  await turn()
  expect(signal?.aborted).toBe(false)
  controller.abort()
  await expect(response).resolves.toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(true)
  pending.resolve(result)
  await turn()
  expect(outbound).toEqual([{ type: 'result', id: 1, operation: 'list', value: result }])
  deliver(child)
  await close(child)
})

it('a pending queued cancellation still aborts before the queued scanner begins', async () => {
  const child = createClient()
  const pending = Promise.withResolvers<typeof result>()
  const signals: AbortSignal[] = []
  scan.mockImplementation((options) => {
    if (!options.signal) {
      throw new Error('Expected the owned scanner signal')
    }
    signals.push(options.signal)
    return signals.length === 1 ? pending.promise : Promise.resolve(result)
  })
  const response = currentClient().listSessions({})
  deliver(child)
  await turn()
  process.emit('message', { type: 'request', id: 999, operation: 'list', params: {} })
  process.emit('message', { type: 'cancel', id: 999 })
  expect(signals).toHaveLength(1)
  pending.resolve(result)
  await turn()
  expect(signals).toHaveLength(2)
  expect(signals[1]?.aborted).toBe(true)
  expect(outbound).toEqual([
    { type: 'result', id: 1, operation: 'list', value: result },
    { type: 'result', id: 999, operation: 'list', value: result }
  ])
  deliver(child)
  await expect(response).resolves.toEqual(result)
  deliver(child)
  await close(child)
})

it('unknown, pre-init and duplicate completed cancels preserve the next live request', async () => {
  process.emit('message', { type: 'cancel', id: 9000 })
  const child = createClient()
  const first = currentClient().listSessions({})
  deliver(child)
  await turn()
  deliver(child)
  await expect(first).resolves.toEqual(result)
  for (const id of [1, 1, 9000, 9000]) {
    process.emit('message', { type: 'cancel', id })
  }
  expect(outbound).toEqual([])
  const live = currentClient().listSessions({})
  await turn()
  expect(scan.mock.calls[1]?.[0].signal?.aborted).toBe(false)
  expect(outbound).toEqual([{ type: 'result', id: 2, operation: 'list', value: result }])
  deliver(child)
  await expect(live).resolves.toEqual(result)
  await close(child)
})

it('shutdown aborts active work and ignores later cancellations and admission', async () => {
  const child = createClient()
  const pending = Promise.withResolvers<typeof result>()
  let signal: AbortSignal | undefined
  scan.mockImplementationOnce((options) => {
    signal = options.signal
    return pending.promise
  })
  const response = currentClient().listSessions({})
  const rejected = expect(response).rejects.toThrow('scan stopped')
  deliver(child)
  await turn()
  process.emit('message', { type: 'shutdown' })
  expect(signal?.aborted).toBe(true)
  process.emit('message', { type: 'cancel', id: 1 })
  process.emit('message', { type: 'cancel', id: 9000 })
  process.emit('message', { type: 'request', id: 9000, operation: 'list', params: {} })
  pending.reject(new Error('scan stopped'))
  await turn()
  expect(scan).toHaveBeenCalledOnce()
  expect(outbound).toEqual([{ type: 'error', id: 1, message: 'scan stopped' }])
  deliver(child)
  await rejected
  await close(child)
})
