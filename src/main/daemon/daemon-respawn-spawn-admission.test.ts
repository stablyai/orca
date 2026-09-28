import './mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonFreshSpawnAdmission } from './daemon-fresh-spawn-admission'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

it('checks the newly degraded admission after a spawn reconnects through respawn', async () => {
  const spawn = vi.fn(() => createMockSubprocess())
  const harness = await startDaemonAdapterHarness(spawn)
  cleanups.push(
    () => rmSync(harness.dir, { recursive: true, force: true }),
    () => harness.server.shutdown(),
    () => harness.adapter.dispose()
  )
  const admission = new DaemonFreshSpawnAdmission(null)
  const healthy = vi.fn(async () => false)
  const adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    freshSpawnAdmission: admission,
    respawn: async () => {
      const replacement = new DaemonServer({
        socketPath: harness.socketPath,
        tokenPath: harness.tokenPath,
        spawnSubprocess: spawn
      })
      await replacement.start()
      cleanups.push(() => replacement.shutdown())
      admission.reset(healthy)
    }
  })
  cleanups.push(() => adapter.dispose())
  await adapter.spawn({ cols: 80, rows: 24 })
  await harness.server.shutdown()
  await expect(adapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
    'Terminal service unavailable'
  )
  expect(spawn).toHaveBeenCalledOnce()
  healthy.mockResolvedValue(true)
  await expect(adapter.recoverFreshSpawnRouting(true)).resolves.toBe(true)
  await adapter.spawn({ cols: 80, rows: 24 })
  expect(spawn).toHaveBeenCalledTimes(2)
})

it('allows only retained attach while degraded, never cold-creating a missing ID', async () => {
  const spawn = vi.fn(() => createMockSubprocess())
  const harness = await startDaemonAdapterHarness(spawn)
  cleanups.push(
    () => rmSync(harness.dir, { recursive: true, force: true }),
    () => harness.server.shutdown(),
    () => harness.adapter.dispose()
  )
  const retained = await harness.adapter.spawn({ cols: 80, rows: 24 })
  const admission = new DaemonFreshSpawnAdmission(async () => false)
  const adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    freshSpawnAdmission: admission
  })
  cleanups.push(() => adapter.dispose())
  await expect(
    adapter.spawn({ sessionId: retained.id, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ id: retained.id, isReattach: true })
  await expect(
    adapter.spawn({ sessionId: retained.id, attachOnly: true, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ id: retained.id, isReattach: true })
  await expect(adapter.spawn({ sessionId: 'missing', cols: 80, rows: 24 })).rejects.toThrow(
    'Terminal service unavailable'
  )
  const getSize = adapter.getAppliedSize.bind(adapter)
  vi.spyOn(adapter, 'getAppliedSize').mockImplementationOnce(async (id) => {
    const size = await getSize(id)
    await harness.adapter.shutdown(id, { immediate: true })
    return size
  })
  await expect(adapter.spawn({ sessionId: retained.id, cols: 80, rows: 24 })).rejects.toThrow()
  expect(spawn).toHaveBeenCalledOnce()
})

it('does not let a stale successful health probe admit a replacement incarnation', async () => {
  let finish!: (healthy: boolean) => void
  const admission = new DaemonFreshSpawnAdmission(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = admission.recover()
  await Promise.resolve()
  const replacement = vi.fn(async () => false)
  admission.reset(replacement)
  finish(true)
  await expect(first).resolves.toBe(false)
  expect(admission.unavailable).toBe(true)
  expect(replacement).toHaveBeenCalledOnce()
})
