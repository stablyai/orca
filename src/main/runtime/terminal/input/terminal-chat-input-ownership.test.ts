import { afterEach, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import { TerminalPromptInputQueue } from './terminal-chat-input-ownership'

afterEach(() => vi.useRealTimers())

it('retires expired queued inputs while a generated predecessor still owns the serializer', async () => {
  vi.useFakeTimers()
  const queue = new TerminalPromptInputQueue(new TerminalRunFactsRegister())
  const predecessor = Promise.withResolvers<void>()
  const prior = queue.serialize('pty', 1, () => predecessor.promise)
  const lifecycle = new AbortController()
  const calls: string[] = []
  const stale = Array.from({ length: 8 }, (_, index) => {
    const entry = queue.admit('pty', 1, [`stale-${index}`], 1_000_000, lifecycle.signal)!
    return queue.serialize('pty', 1, async () => {
      entry.start()
      try {
        entry.signal.throwIfAborted()
        calls.push(entry.frames![0])
      } catch {
        // Expired queued input must never reach the writer.
      } finally {
        entry.finish()
      }
    })
  })
  await vi.advanceTimersByTimeAsync(30_000)
  const fresh = queue.admit('pty', 1, ['fresh'], 10_000_000, lifecycle.signal)
  expect(fresh).not.toBeNull()
  const sent = queue.serialize('pty', 1, async () => {
    fresh!.start()
    fresh!.signal.throwIfAborted()
    calls.push(fresh!.frames![0])
    fresh!.finish()
  })
  predecessor.resolve()
  await Promise.all([prior, ...stale, sent])
  expect(calls).toEqual(['fresh'])
})

it('keeps an active payload charged until its canceled writer unwinds', () => {
  const lifecycle = new AbortController()
  const queue = new TerminalPromptInputQueue(new TerminalRunFactsRegister())
  const active = queue.admit('old', 1, ['body'], 10_000_000, lifecycle.signal)!
  active.start()
  lifecycle.abort()
  const nextLifecycle = new AbortController()
  expect(queue.admit('new', 2, ['next'], 10_000_000, nextLifecycle.signal)).toBeNull()
  active.finish()
  const next = queue.admit('new', 2, ['next'], 10_000_000, nextLifecycle.signal)
  expect(next).not.toBeNull()
  next!.finish()
})

it.each([40, 400])(
  'invalidates only the input owner addressed among %i occupied terminals',
  (count) => {
    const facts = new TerminalRunFactsRegister()
    let visited = 0
    const subscribe = facts.onPtyInput.bind(facts)
    vi.spyOn(facts, 'onPtyInput').mockImplementation((pty, listener) =>
      subscribe(pty, () => {
        visited++
        listener()
      })
    )
    const queue = new TerminalPromptInputQueue(facts)
    const lifecycles = Array.from({ length: count }, () => new AbortController())
    const entries = Array.from({ length: count }, (_, index) =>
      queue.admit(`pty-${index}`, 1, ['draft'], 10, lifecycles[index].signal)!
    )
    facts.recordInput('pty-0', 'driving', 'manual draft')
    // One terminal's input owes one invalidation, regardless of the number of other open terminals.
    expect(visited).toBe(1)
    expect(entries.filter((entry) => entry.signal.aborted)).toEqual([entries[0]])
    lifecycles.forEach((lifecycle) => lifecycle.abort())
  }
)
