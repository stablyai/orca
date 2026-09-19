import { expect, it, vi } from 'vitest'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'

it('stops in reverse acquisition order and releases the instance lock last', async () => {
  const events: string[] = []
  const lifetime = new OrcadRuntimeLifetime(() => {
    events.push('lock')
  })
  lifetime.add(() => {
    events.push('browser')
  })
  lifetime.add(async () => {
    events.push('daemon')
  })
  lifetime.add(() => {
    events.push('rpc')
  })
  const stopping = lifetime.stop()
  expect(lifetime.stop()).toBe(stopping)
  expect(() => lifetime.add(() => {})).toThrow('lifetime_stopping')
  await stopping
  expect(events).toEqual(['rpc', 'daemon', 'browser', 'lock'])
  await lifetime.stop()
  expect(events).toHaveLength(4)
})

it('awaits pending cleanup before stopping dependencies or releasing the lock', async () => {
  const release = vi.fn()
  const lifetime = new OrcadRuntimeLifetime(release)
  const dependency = vi.fn()
  let finish!: () => void
  lifetime.add(dependency)
  lifetime.add(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const stopping = lifetime.stop()
  await Promise.resolve()
  expect(release).not.toHaveBeenCalled()
  expect(dependency).not.toHaveBeenCalled()
  finish()
  await stopping
  expect(dependency).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it('attempts every cleanup but retains the lock if any resource cannot stop', async () => {
  const release = vi.fn()
  const lifetime = new OrcadRuntimeLifetime(release)
  const finalCleanup = vi.fn()
  const first = new Error('rpc failed')
  const second = new Error('browser failed')
  lifetime.add(finalCleanup)
  lifetime.add(() => {
    throw second
  })
  lifetime.add(async () => {
    throw first
  })
  const stopping = lifetime.stop()
  await expect(stopping).rejects.toMatchObject({ errors: [first, second] })
  expect(finalCleanup).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
  expect(lifetime.stop()).toBe(stopping)
})
