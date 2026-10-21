import { expect, it } from 'vitest'
import {
  hasSshTestConnectionProbes,
  runSshTestConnectionProbe,
  testingTargets
} from './ssh-connect-attempt-registry'

it('publishes target-scoped presence before callbacks and retains it until settlement', async () => {
  const target = 'probe-presence-success'
  const work = Promise.withResolvers<void>()
  const probe = runSshTestConnectionProbe(target, async () => {
    expect(hasSshTestConnectionProbes(target)).toBe(true)
    await work.promise
  })
  expect(hasSshTestConnectionProbes(target)).toBe(true)
  expect(hasSshTestConnectionProbes('unrelated')).toBe(false)
  testingTargets.delete(target)
  expect(hasSshTestConnectionProbes(target)).toBe(true)
  work.resolve()
  await probe
  expect(hasSshTestConnectionProbes(target)).toBe(false)
})

it('keeps other probes visible after a failed probe settles', async () => {
  const target = 'probe-presence-failure'
  const work = Promise.withResolvers<void>()
  const pending = runSshTestConnectionProbe(target, () => work.promise)
  const failed = runSshTestConnectionProbe(target, async () => {
    throw new Error('failed')
  })
  await expect(failed).rejects.toThrow('failed')
  expect(hasSshTestConnectionProbes(target)).toBe(true)
  work.resolve()
  await pending
  expect(hasSshTestConnectionProbes(target)).toBe(false)
})
