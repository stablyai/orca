import { expect, it, vi } from 'vitest'
import {
  credentialRequestedForTarget,
  runSshTestConnectionProbe,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'

it('publishes global and target tracking before callback-capable work', async () => {
  const close = Promise.withResolvers<void>()
  const operation = vi.fn(async () => {
    expect(testConnectionProbes.has(probe)).toBe(true)
    expect(testingTargets.has('published')).toBe(true)
    await close.promise
    return 'connected'
  })
  const probe = runSshTestConnectionProbe('published', operation)
  expect(operation).not.toHaveBeenCalled()
  expect(testConnectionProbes.has(probe)).toBe(true)
  close.resolve()
  await expect(probe).resolves.toBe('connected')
  expect(testConnectionProbes.has(probe)).toBe(false)
  expect(testingTargets.has('published')).toBe(false)
})

it('retains callback suppression until the final probe for a target settles', async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const a = runSshTestConnectionProbe('multiple', () => first.promise)
  const b = runSshTestConnectionProbe('multiple', () => second.promise)
  credentialRequestedForTarget.add('multiple')
  first.resolve()
  await a
  expect(testingTargets.has('multiple')).toBe(true)
  expect(credentialRequestedForTarget.has('multiple')).toBe(true)
  second.resolve()
  await b
  expect(testingTargets.has('multiple')).toBe(false)
  expect(credentialRequestedForTarget.has('multiple')).toBe(false)
})

it('keeps a pending probe tracked after another probe for the target fails', async () => {
  const work = Promise.withResolvers<void>()
  const pending = runSshTestConnectionProbe('failed', () => work.promise)
  const failed = runSshTestConnectionProbe('failed', async () => {
    throw new Error('connection failed')
  })
  await expect(failed).rejects.toThrow('connection failed')
  expect(testConnectionProbes.has(failed)).toBe(false)
  expect(testingTargets.has('failed')).toBe(true)
  work.resolve()
  await pending
  expect(testingTargets.has('failed')).toBe(false)
})

it('does not clear another target when a probe settles', async () => {
  const close = Promise.withResolvers<void>()
  const other = runSshTestConnectionProbe('other', () => close.promise)
  await runSshTestConnectionProbe('absent', async () => undefined)
  expect(testingTargets.has('other')).toBe(true)
  expect(testConnectionProbes.has(other)).toBe(true)
  close.resolve()
  await other
})
