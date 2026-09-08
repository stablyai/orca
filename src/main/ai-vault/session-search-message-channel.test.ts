import { expect, it } from 'vitest'
import { SessionSearchMessageChannel } from './session-search-message-channel'

const message = (text: string) => ({ role: 'user' as const, text, timestamp: null })

/** Resolves to 'stalled' when a producer is never woken, instead of hanging the run. */
function settledOrStalled(promises: Promise<unknown>[]): Promise<string> {
  return Promise.race([
    Promise.all(promises).then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 250))
  ])
}

it('resumes every producer waiting on a checkpoint, not just the last one', async () => {
  const channel = new SessionSearchMessageChannel()
  channel.push(message('first'))
  const first = channel.checkpoint()
  channel.push(message('second'))
  const second = channel.checkpoint()
  const drained: string[] = []
  const consumer = (async () => {
    for await (const value of channel) {
      drained.push(value.text)
    }
  })()
  channel.close()
  await consumer
  expect(drained).toEqual(['first', 'second'])
  expect(await settledOrStalled([first, second])).toBe('settled')
})

it('releases checkpoint waiters when the consumer stops', async () => {
  const channel = new SessionSearchMessageChannel()
  channel.push(message('first'))
  const first = channel.checkpoint()
  channel.push(message('second'))
  const second = channel.checkpoint()
  channel.stop()
  expect(await settledOrStalled([first, second])).toBe('settled')
})
