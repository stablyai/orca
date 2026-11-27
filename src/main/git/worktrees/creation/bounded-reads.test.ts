import { expect, it } from 'vitest'
import { forEachBounded } from './bounded-reads'

it('rejects only after reads already started have settled', async () => {
  let releaseHeld!: () => void
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  let settled = false
  const run = forEachBounded(['held', 'failing'], (item) =>
    item === 'held' ? held : Promise.reject(new Error('EIO'))
  ).finally(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)

  releaseHeld()
  await expect(run).rejects.toThrow('EIO')
})
