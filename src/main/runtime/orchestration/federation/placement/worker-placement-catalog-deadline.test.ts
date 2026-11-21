import { expect, it } from 'vitest'
import { CatalogDeadline, CatalogOwnerRead } from './worker-placement-catalog-deadline'

it('settles a closed caller while another caller can still receive the shared result', async () => {
  const rpc = Promise.withResolvers<string>()
  const read = new CatalogOwnerRead(() => rpc.promise)
  const abandoned = new CatalogDeadline()
  const active = new CatalogDeadline()
  const first = read.wait(abandoned)
  const second = read.wait(active)
  abandoned.close()
  expect(await first).toBeUndefined()
  rpc.resolve('catalog')
  expect(await second).toBe('catalog')
  active.close()
})
