import { expect, it } from 'vitest'
import { acquireQueueTurn } from './agent-prompt-queue-turn'

const PTY = 'pty-input-dispatch'

it('orders turns per generation, keeps a replacement tail, and retires a queued turn on abort', async () => {
  const tails = new Map<string, Promise<void>>()
  const turn = (generation: number, signal?: AbortSignal) =>
    acquireQueueTurn(tails, `${PTY}\u0000${generation}`, signal)
  const calls: string[] = []
  const releaseFirst = await turn(1)
  calls.push('first')
  const abandoned = new AbortController()
  const queued = turn(1, abandoned.signal)
  const second = turn(1).then((release) => {
    calls.push('second')
    return release
  })
  const fresh = await turn(2)
  calls.push('fresh')
  fresh()
  // A queued caller that gives up settles at once and runs nothing, while the head still holds.
  abandoned.abort()
  await expect(queued).rejects.toThrow('request_aborted')
  expect(calls).toEqual(['first', 'fresh'])
  const replacement = Promise.resolve()
  const key = `${PTY}\u00001`
  tails.set(key, replacement)
  releaseFirst()
  ;(await second)()
  expect(calls).toEqual(['first', 'fresh', 'second'])
  await Promise.resolve()
  expect(tails.get(key)).toBe(replacement)
  expect(tails.has(`${PTY}\u00002`)).toBe(false)
})
