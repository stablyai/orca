import { expect, it } from 'vitest'
import { structuredWorkerLaunchOptions } from './worker-launch-preferences'

it('preserves an explicit worker approval boundary instead of inheriting a wider chat default', () => {
  const options = structuredWorkerLaunchOptions({
    model: 'fixture-model',
    effort: 'low',
    mode: 'auto'
  })
  expect(options).toEqual({ model: 'fixture-model', effort: 'low', permissionMode: 'auto' })
})
