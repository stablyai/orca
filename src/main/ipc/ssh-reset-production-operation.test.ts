import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { runProductionSshResetOperation } from './ssh-reset-production-operation'

const state = vi.hoisted(() => ({
  slots: new Set<string>(),
  authorities: new Set<string>(),
  connects: new Map<string, { promise: Promise<unknown> }>(),
  resets: new Map<string, Promise<void>>(),
  joinProbes: vi.fn().mockResolvedValue(undefined),
  capture: vi.fn(),
  allowed: vi.fn(),
  shutdown: vi.fn(),
  clearBackoff: vi.fn()
}))
vi.mock('./ssh-target-destruction-admission', () => ({
  assertManualSshTargetDestructionAllowed: state.allowed
}))
vi.mock('./ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: state.shutdown,
  connectInFlight: state.connects,
  resetRelayInFlight: state.resets,
  awaitSshTestConnectionProbes: state.joinProbes
}))
vi.mock('./ssh-relay-lost-backoff', () => ({ clearRelayLostBackoff: state.clearBackoff }))
vi.mock('./ssh-reset-production-capture', () => ({
  captureProductionSshResetOperation: state.capture
}))
vi.mock('./ssh-reset-production-state', () => ({
  sshResetOperationAuthorities: { get: (id: string) => state.authorities.has(id) },
  reserveSshResetCapture: (id: string) => {
    if (state.slots.has(id)) {
      throw new Error('already reserved')
    }
    state.slots.add(id)
    return {
      assertCurrent: () => {
        if (!state.slots.has(id)) {
          throw new Error('missing reservation')
        }
      },
      release: () => {
        if (state.authorities.has(id)) {
          throw new Error('still retained')
        }
        state.slots.delete(id)
      }
    }
  }
}))

afterEach(() => {
  state.connects.clear()
  state.resets.clear()
  state.authorities.clear()
  state.slots.clear()
  vi.resetAllMocks()
  state.joinProbes.mockResolvedValue(undefined)
})
const signal = () => new AbortController().signal
const completion = { version: 1, localRetired: true }

it('reserves synchronously and coalesces reentrant capture and concurrent requests', async () => {
  const id = randomUUID()
  let reentrant: Promise<unknown> | undefined
  const run = vi.fn().mockResolvedValue(completion)
  state.capture.mockImplementation(() => {
    expect(state.slots.has(id)).toBe(true)
    reentrant = runProductionSshResetOperation(id, signal())
    return { run }
  })
  const first = runProductionSshResetOperation(id, signal())
  expect(state.slots.has(id)).toBe(true)
  expect(state.resets.has(id)).toBe(true)
  expect(runProductionSshResetOperation(id, signal())).toBe(first)
  await expect(first).resolves.toEqual(completion)
  expect(reentrant).toBe(first)
  expect(state.capture).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledTimes(1)
  expect(state.slots.has(id)).toBe(false)
  expect(state.resets.has(id)).toBe(false)
})

it('joins a failed admitted connect and then all target probes before capture', async () => {
  const id = randomUUID()
  let rejectConnect!: (error: Error) => void
  let finishProbes!: () => void
  state.connects.set(id, {
    promise: new Promise((_, reject) => {
      rejectConnect = reject
    })
  })
  state.joinProbes.mockReturnValue(
    new Promise<void>((resolve) => {
      finishProbes = resolve
    })
  )
  state.capture.mockResolvedValue({ run: vi.fn().mockResolvedValue(completion) })
  const result = runProductionSshResetOperation(id, signal())
  await vi.waitFor(() => expect(state.shutdown).toHaveBeenCalled())
  expect(state.capture).not.toHaveBeenCalled()
  rejectConnect(new Error('connect failed'))
  await vi.waitFor(() => expect(state.joinProbes).toHaveBeenCalledWith(id))
  expect(state.capture).not.toHaveBeenCalled()
  finishProbes()
  await expect(result).resolves.toEqual(completion)
})

it('releases a failed read-only capture and allows a fresh capture', async () => {
  const id = randomUUID()
  state.capture.mockRejectedValueOnce(new Error('status unavailable'))
  await expect(runProductionSshResetOperation(id, signal())).rejects.toThrow('status unavailable')
  expect(state.slots.has(id)).toBe(false)
  state.capture.mockResolvedValue({ run: vi.fn().mockResolvedValue(completion) })
  await expect(runProductionSshResetOperation(id, signal())).resolves.toEqual(completion)
  expect(state.capture).toHaveBeenCalledTimes(2)
})

it('retains a failed controller and retries it without capture or host status probes', async () => {
  const id = randomUUID()
  const run = vi.fn().mockRejectedValueOnce(new Error('uncertain')).mockResolvedValue(completion)
  state.capture.mockResolvedValue({ run })
  await expect(runProductionSshResetOperation(id, signal())).rejects.toThrow('uncertain')
  expect(state.slots.has(id)).toBe(true)
  await expect(runProductionSshResetOperation(id, signal())).resolves.toEqual(completion)
  expect(state.capture).toHaveBeenCalledTimes(1)
  expect(state.joinProbes).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledTimes(2)
})

it('refuses success until exact controller authority was released', async () => {
  const id = randomUUID()
  state.capture.mockImplementation(() => {
    state.authorities.add(id)
    return { run: vi.fn().mockResolvedValue(completion) }
  })
  await expect(runProductionSshResetOperation(id, signal())).rejects.toThrow('still retained')
  expect(state.slots.has(id)).toBe(true)
  state.authorities.delete(id)
  await expect(runProductionSshResetOperation(id, signal())).resolves.toEqual(completion)
  expect(state.capture).toHaveBeenCalledTimes(1)
})

it('does not reserve or capture a pre-aborted request', () => {
  const id = randomUUID()
  const abort = new AbortController()
  abort.abort()
  expect(() => runProductionSshResetOperation(id, abort.signal)).toThrow()
  expect(state.slots.has(id)).toBe(false)
  expect(state.capture).not.toHaveBeenCalled()
})

it('cannot start a retained retry after shutdown closes admission', async () => {
  const id = randomUUID()
  const run = vi.fn().mockRejectedValueOnce(new Error('uncertain')).mockResolvedValue(completion)
  state.capture.mockResolvedValue({ run })
  await expect(runProductionSshResetOperation(id, signal())).rejects.toThrow('uncertain')
  state.shutdown.mockImplementation(() => {
    throw new Error('shutdown')
  })
  expect(() => runProductionSshResetOperation(id, signal())).toThrow('shutdown')
  expect(run).toHaveBeenCalledTimes(1)
  expect(state.slots.has(id)).toBe(true)
  state.shutdown.mockReset()
  await expect(runProductionSshResetOperation(id, signal())).resolves.toEqual(completion)
})
