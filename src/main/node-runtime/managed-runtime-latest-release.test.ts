import { expect, it } from 'vitest'
import { hourlyLookup } from './managed-runtime-latest-release'

it('lets a caller with a signal leave a stalled lookup another caller started without one', async () => {
  const lookup = hourlyLookup(() => new Promise<string>(() => {}))
  void lookup.refresh()
  const controller = new AbortController()
  const joined = lookup.refresh(controller.signal)
  controller.abort(new Error('install cancelled'))
  await expect(joined).rejects.toThrow('install cancelled')
})

it('waits out the hour after a failed lookup, unless an install asks while nothing is known', async () => {
  const lookup = hourlyLookup<string>(async () => {
    throw new Error('rate limited')
  })
  await expect(lookup.refresh()).rejects.toThrow('rate limited')
  await expect(lookup.refresh()).resolves.toBeUndefined()
  await expect(lookup.refresh(undefined, true)).rejects.toThrow('rate limited')
})
