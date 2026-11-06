import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRpcPromptDelivery, piRpcFailureFact } from './rpc-prompt-delivery'

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

  it('settles a prompt waiting out a sign-in refusal as never reaching Pi on process teardown', async () => {
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
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(
      'retrying',
      expect.objectContaining({
        state: 'rejected',
        rejection: expect.objectContaining({ kind: 'notSignedIn', neverReachedAgent: true })
      })
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a re-sent sign-in retry still awaiting its reply as unknown on process teardown', async () => {
    vi.useFakeTimers()
    const h = rig()
    await h.delivery.submit('retrying', 1, { type: 'prompt', message: 'first' })
    h.delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for provider'
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.send).toHaveBeenCalledTimes(2)
    h.delivery.end()
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(
      'retrying',
      expect.objectContaining({ state: 'unknown' })
    )
  })
})

it('retains Pi provider detail with sign-in guidance after bounded authentication retries', async () => {
  // Pi 0.73.1, recorded from a signed-out temporary home.
  const error =
    'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/providers.md\n  /opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/models.md'
  vi.useFakeTimers()
  const h = rig()
  await h.delivery.submit('signed-out', 1, { type: 'prompt', message: 'hello' })
  for (let attempt = 0; attempt < 9; attempt += 1) {
    h.delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error
    })
    await vi.advanceTimersByTimeAsync(250)
  }
  expect(h.settled).toHaveBeenCalledExactlyOnceWith(
    'signed-out',
    expect.objectContaining({
      state: 'rejected',
      rejection: {
        kind: 'notSignedIn',
        detail: { text: error, audience: 'log' },
        // Pi checks sign-in before it records a prompt, so the agent never had this one.
        neverReachedAgent: true
      }
    })
  )
})

// Pi b556cfe5: auth/resolve.ts, utils/error-body.ts and api/bedrock-converse-stream.ts.
it.each([
  [
    'OAuth refresh failed for openai-codex: token refresh failed (400): invalid_grant',
    'notSignedIn'
  ],
  ['OAuth refresh failed for openai-codex: fetch failed', 'providerRejected'],
  ['401: Invalid bearer token', 'notSignedIn'],
  ['OpenAI API error (401): Unauthorized', 'notSignedIn'],
  ['UnrecognizedClientException: 401: Invalid security token', 'notSignedIn'],
  ['403: Organization policy denies this model', 'providerRejected'],
  ['OpenAI API error (503): upstream reported 401', 'providerRejected'],
  ['Service unavailable: 503: upstream reported 401', 'providerRejected'],
  ['The message mentions 401 but has no status envelope', 'providerRejected'],
  ['OAuth refresh failed for openai-codex: 401: network unavailable', 'providerRejected']
])('settles %s without retrying an unusable grant', async (error, kind) => {
  vi.useFakeTimers()
  const h = rig()
  await h.delivery.submit('auth-failure', 1, { type: 'prompt', message: 'hello' })
  h.delivery.reply({ type: 'response', command: 'prompt', success: false, error })
  expect(h.settled).toHaveBeenCalledWith(
    'auth-failure',
    expect.objectContaining({ state: 'rejected', rejection: expect.objectContaining({ kind }) })
  )
  await vi.runAllTimersAsync()
  expect(h.send).toHaveBeenCalledOnce()
})

it.each([100, 1000])('classifies a refresh diagnostic with %i token mentions', (count) => {
  const prefix = 'OAuth refresh failed for openai-codex: '
  const mentions = 'refresh token '.repeat(count)
  const diagnostic = prefix + mentions
  const exec = RegExp.prototype.exec
  let scanSteps = 0
  const scan = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text) {
    if (text === diagnostic && this.global) {
      scanSteps += 1
    }
    return exec.call(this, text)
  })
  let kind: string
  try {
    kind = piRpcFailureFact(diagnostic).kind
  } finally {
    scan.mockRestore()
  }
  expect(kind).toBe('providerRejected')
  expect(scanSteps).toBeGreaterThan(0)
  // One advancing token per mention, plus the terminal search; no repeated suffix searches.
  expect(scanSteps).toBeLessThanOrEqual(count + 1)
  expect(piRpcFailureFact(`${prefix}${mentions}expired`).kind).toBe('notSignedIn')
  expect(piRpcFailureFact(`${prefix}${mentions}\nexpired`).kind).toBe('providerRejected')
  expect(piRpcFailureFact(`${prefix}${mentions}\nrefresh\ntoken expired`).kind).toBe('notSignedIn')
})
