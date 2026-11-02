import { expect, it, vi } from 'vitest'
import {
  awaitSshTestConnectionProbes,
  credentialRequestedForTarget,
  runSshTestConnectionProbe,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('publishes global and target tracking before callback-capable work', async () => {
  const close = deferred()
  let joined!: Promise<void>
  const finished = vi.fn()
  const operation = vi.fn(async () => {
    expect(testConnectionProbes.has(probe)).toBe(true)
    expect(testingTargets.has('published')).toBe(true)
    joined = awaitSshTestConnectionProbes('published').then(finished)
    await close.promise
    return 'connected'
  })
  const probe = runSshTestConnectionProbe('published', operation)
  expect(operation).not.toHaveBeenCalled()
  expect(testConnectionProbes.has(probe)).toBe(true)
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  close.resolve()
  await expect(probe).resolves.toBe('connected')
  await joined
  expect(finished).toHaveBeenCalledTimes(1)
  expect(testConnectionProbes.has(probe)).toBe(false)
  expect(testingTargets.has('published')).toBe(false)
})

it('joins every admitted probe and retains callback suppression until the final settlement', async () => {
  const first = deferred()
  const second = deferred()
  const a = runSshTestConnectionProbe('multiple', () => first.promise)
  const b = runSshTestConnectionProbe('multiple', () => second.promise)
  credentialRequestedForTarget.add('multiple')
  const finished = vi.fn()
  const joined = awaitSshTestConnectionProbes('multiple').then(finished)
  first.resolve()
  await a
  expect(testingTargets.has('multiple')).toBe(true)
  expect(credentialRequestedForTarget.has('multiple')).toBe(true)
  expect(finished).not.toHaveBeenCalled()
  second.resolve()
  await b
  await joined
  expect(testingTargets.has('multiple')).toBe(false)
  expect(credentialRequestedForTarget.has('multiple')).toBe(false)
})

it('joins failed probes without mistaking rejection for unfinished work', async () => {
  const failure = new Error('connection failed')
  const probe = runSshTestConnectionProbe('failed', async () => {
    throw failure
  })
  const result = expect(probe).rejects.toBe(failure)
  await expect(awaitSshTestConnectionProbes('failed')).resolves.toBeUndefined()
  await result
  expect(testConnectionProbes.has(probe)).toBe(false)
  expect(testingTargets.has('failed')).toBe(false)
})

it('does not wait for another target', async () => {
  const close = deferred()
  const probe = runSshTestConnectionProbe('other', () => close.promise)
  await awaitSshTestConnectionProbes('absent')
  expect(testConnectionProbes.has(probe)).toBe(true)
  close.resolve()
  await probe
})

it('rechecks the target after a joined snapshot settles', async () => {
  const first = deferred()
  const second = deferred()
  const a = runSshTestConnectionProbe('later', () => first.promise)
  const finished = vi.fn()
  const joined = awaitSshTestConnectionProbes('later').then(finished)
  const b = runSshTestConnectionProbe('later', () => second.promise)
  first.resolve()
  await a
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  second.resolve()
  await b
  await joined
  expect(finished).toHaveBeenCalledTimes(1)
})
