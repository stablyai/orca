import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { DaemonProviderProcesses } from './daemon-provider-processes'

vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

it.each([10, 100])('drains %i live roots without rescanning retained outcomes', async (count) => {
  const children: EventEmitter[] = []
  vi.mocked(spawnProcess).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn(() => true) })
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This held-child fixture supplies the PID, events and kill method used by the provider registry.
    return child as never
  })
  const owner = new Socket()
  vi.spyOn(owner, 'write').mockReturnValue(true)
  const live: boolean[] = []
  const providers = new DaemonProviderProcesses(true, () => live.push(providers.hasLive))
  const nonces = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'))
  for (const nonce of nonces) {
    await providers.spawn({ nonce, source: '', args: [], cwd: '/tmp', env: {} }, owner)
  }
  const iteration = vi.spyOn(Map.prototype, 'values')
  for (const child of children) {
    child.emit('exit', 0, null)
    child.emit('close')
  }
  expect(providers.hasLive).toBe(false)
  expect(live.at(-1)).toBe(false)
  expect(iteration).not.toHaveBeenCalled()
  for (const nonce of nonces) {
    expect(providers.query(nonce, owner)).toMatchObject({ state: 'exited', outcome: { code: 0 } })
  }
  await expect(
    providers.spawn({ nonce: nonces[0]!, source: '', args: [], cwd: '/tmp', env: {} }, owner)
  ).rejects.toThrow('already dispatched')
  iteration.mockRestore()
  await providers.dispose()
  owner.destroy()
})

it('retains known no-starts before publishing and never replaces a live nonce on refusal', async () => {
  const owner = new Socket()
  const providers = new DaemonProviderProcesses(true, () => {})
  const published: unknown[] = []
  vi.spyOn(owner, 'write').mockImplementation((record) => {
    const event = JSON.parse(String(record))
    expect(providers.query(event.nonce, owner)).toEqual({ state: 'exited', outcome: event.outcome })
    published.push(event.outcome)
    return true
  })
  const spec = { nonce: 'a'.repeat(64), source: '', args: [], cwd: '/tmp', env: {} }
  try {
    await expect(providers.spawn({ ...spec, cwd: undefined! }, owner)).rejects.toThrow(
      'Invalid provider launch'
    )
    expect(published).toEqual([{ pid: null, code: null, signal: null, processless: true }])
    const child = Object.assign(new EventEmitter(), { pid: 43, kill: vi.fn(() => true) })
    vi.mocked(spawnProcess).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Registry fixture supplies its held-child PID/events/kill.
      return child as never
    })
    const liveSpec = { ...spec, nonce: 'b'.repeat(64) }
    await providers.spawn(liveSpec, owner)
    await expect(providers.spawn(liveSpec, owner, false)).rejects.toThrow('already dispatched')
    expect(providers.query(liveSpec.nonce, owner)).toEqual({ state: 'live', pid: 43 })
    expect(published).toHaveLength(1)
    child.emit('exit', 0, null)
    child.emit('close')
  } finally {
    await providers.dispose()
    owner.destroy()
  }
})
