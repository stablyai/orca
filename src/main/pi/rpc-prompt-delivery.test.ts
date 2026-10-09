import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRpcPromptDelivery } from './rpc-prompt-delivery'

const deliveries: PiRpcPromptDelivery[] = []
afterEach(() => {
  for (const delivery of deliveries.splice(0)) {
    delivery.end()
  }
  vi.useRealTimers()
})
function rig() {
  const send = vi.fn(async () => {}),
    accepted = vi.fn(),
    settled = vi.fn(),
    beforeWrite = vi.fn()
  const delivery = new PiRpcPromptDelivery({
    send,
    accepted,
    settled,
    beforeWrite,
    commandOnly: vi.fn(),
    rejectedAfterAcceptance: vi.fn(),
    failed: vi.fn()
  })
  deliveries.push(delivery)
  return { delivery, send, accepted, settled, beforeWrite }
}
const queued = {
  type: 'response',
  command: 'prompt',
  success: true,
  data: { disposition: 'queued' }
}

describe('Pi pending prompt delivery bounds and ownership', () => {
  it('bounds queued prompts even after their acknowledgements arrive', async () => {
    const h = rig()
    for (let i = 0; i < 128; i++) {
      await h.delivery.submit(`prompt:${i}`, i, { type: 'prompt', message: 'queued' })
      h.delivery.reply(queued)
    }
    const before = vi.fn(async () => {})
    expect(
      await h.delivery.submit('overflow', 129, { type: 'prompt', message: 'overflow' }, before)
    ).toMatchObject({ state: 'rejected', rejection: { kind: 'queueFull' } })
    expect(before).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(128)
    h.delivery.consumeNext()
    await expect(
      h.delivery.submit('after-consumption', 130, { type: 'prompt', message: 'next' })
    ).resolves.toEqual({ state: 'admitted' })
  })

  it('bounds retained retry payload bytes before journal dispatch admission', async () => {
    const h = rig()
    const frame = { type: 'prompt', message: 'x'.repeat(8 * 1024 * 1024 - 128) }
    for (let i = 0; i < 4; i++) {
      await h.delivery.submit(`large:${i}`, i, frame)
    }
    const before = vi.fn(async () => {})
    expect(await h.delivery.submit('overflow', 5, frame, before)).toMatchObject({
      state: 'rejected',
      rejection: { kind: 'queueFull' }
    })
    expect(before).not.toHaveBeenCalled()
    h.delivery.consumeNext()
    await expect(h.delivery.submit('fits-after-consumption', 6, frame)).resolves.toEqual({
      state: 'admitted'
    })
  })

  it('does not consume an input whose dispatch commit has not finished', async () => {
    const h = rig()
    const pending = Promise.withResolvers<void>()
    const submitted = h.delivery.submit(
      'pending',
      1,
      { type: 'prompt', message: 'pending' },
      () => pending.promise
    )
    expect(h.delivery.consumeNext()).toBe(false)
    expect(h.beforeWrite).not.toHaveBeenCalled()
    pending.resolve()
    await submitted
    expect(h.delivery.consumeNext()).toBe(true)
    expect(h.accepted).toHaveBeenCalledWith('pending', 1)
  })

  it('associates a later run with the prompt actually written while an auth retry waits', async () => {
    vi.useFakeTimers()
    const h = rig()
    await h.delivery.submit('retrying', 1, { type: 'prompt', message: 'first' })
    h.delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for provider'
    })
    await h.delivery.submit('second', 2, { type: 'prompt', message: 'second' })
    h.delivery.consumeNext()
    expect(h.accepted).toHaveBeenCalledExactlyOnceWith('second', 2)
    h.delivery.reply(queued)
    await vi.advanceTimersByTimeAsync(250)
    h.delivery.consumeNext()
    expect(h.accepted).toHaveBeenLastCalledWith('retrying', 1)
  })

  it('settles a pending auth retry as unknown on process teardown', async () => {
    vi.useFakeTimers()
    const h = rig()
    await h.delivery.submit('retrying', 1, { type: 'prompt', message: 'first' })
    h.delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for provider'
    })
    h.delivery.end()
    expect(h.settled).toHaveBeenCalledWith(
      'retrying',
      expect.objectContaining({ state: 'unknown' })
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('retains Pi provider detail with sign-in guidance after bounded authentication retries', async () => {
  vi.useFakeTimers()
  const h = rig()
  await h.delivery.submit('signed-out', 1, { type: 'prompt', message: 'hello' })
  for (let attempt = 0; attempt < 9; attempt += 1) {
    h.delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for anthropic'
    })
    await vi.advanceTimersByTimeAsync(250)
  }
  expect(h.settled).toHaveBeenCalledExactlyOnceWith(
    'signed-out',
    expect.objectContaining({
      state: 'rejected',
      rejection: {
        kind: 'notSignedIn',
        detail: { text: 'No API key found for anthropic', audience: 'person' }
      }
    })
  )
  expect(h.settled.mock.calls[0]?.[1].reason).toContain('No API key found for anthropic')
  expect(h.settled.mock.calls[0]?.[1].reason).toContain('`pi`')
  expect(h.settled.mock.calls[0]?.[1].reason).toContain('`/login`')
})
