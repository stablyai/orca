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
