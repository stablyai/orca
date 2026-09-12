import { expect, it } from 'vitest'
import { getSshProviderAuthority, rotateSshProviderAuthority } from './ssh-provider-authority'
import {
  hasSshProviderContinuations,
  runSshProviderContinuation
} from './ssh-provider-continuations'

it('publishes synchronously before provider callbacks and isolates targets', async () => {
  const work = Promise.withResolvers<void>()
  const pending = runSshProviderContinuation('continuation-publish', async () => {
    expect(hasSshProviderContinuations('continuation-publish')).toBe(true)
    await work.promise
  })
  expect(hasSshProviderContinuations('continuation-publish')).toBe(true)
  expect(hasSshProviderContinuations('unrelated')).toBe(false)
  work.resolve()
  await pending
  expect(hasSshProviderContinuations('continuation-publish')).toBe(false)
})

it('retains work across authority rotation and early observer cancellation', async () => {
  const target = 'continuation-cancel'
  getSshProviderAuthority(target)
  const work = Promise.withResolvers<string>()
  const pending = runSshProviderContinuation(target, () => work.promise)
  await expect(Promise.race([pending, Promise.resolve('cancelled')])).resolves.toBe('cancelled')
  rotateSshProviderAuthority(target)
  expect(hasSshProviderContinuations(target)).toBe(true)
  work.resolve('settled')
  await expect(pending).resolves.toBe('settled')
  expect(hasSshProviderContinuations(target)).toBe(false)
})

it('settles synchronous failure without hiding another operation', async () => {
  const target = 'continuation-failure'
  const work = Promise.withResolvers<void>()
  const pending = runSshProviderContinuation(target, () => work.promise)
  await expect(
    runSshProviderContinuation(target, () => {
      throw new Error('failed')
    })
  ).rejects.toThrow('failed')
  expect(hasSshProviderContinuations(target)).toBe(true)
  work.reject(new Error('later failure'))
  await expect(pending).rejects.toThrow('later failure')
  expect(hasSshProviderContinuations(target)).toBe(false)
})
