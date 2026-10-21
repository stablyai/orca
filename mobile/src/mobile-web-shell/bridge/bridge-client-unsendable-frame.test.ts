import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge-caps'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

/**
 * A frame the page cannot serialize, which is a send that failed and not an exception.
 *
 * `sendFrame` never throws, and every caller below it depends on that: `sendRequest` opens the id
 * before it posts and abandons it on the way out, so a throw escaping the post skips the abandon and
 * holds one of sixty-four in-flight slots for the life of the page. Sixty-four such calls and the
 * client refuses every request afterwards with nothing on screen to say why.
 *
 * Measured on this tree with serialization outside the `try`: one cyclic `params` left 63 of the 64
 * slots usable, raised no diagnostic at all, and rejected the caller with a bare `TypeError` from
 * `JSON.stringify` rather than the send failure the contract names. The cases below are that
 * difference, and they red on the serialization moving back out.
 *
 * `params` is the surface, not a hypothetical: every value in a page frame is one a screen handed
 * in, and a cycle, a `BigInt` or a throwing `toJSON` all reach here the same way.
 */

/** A `params` `JSON.stringify` refuses. The self-reference is the whole fixture. */
function cyclicParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { worktree: 'id:wt-1' }
  params.self = params
  return params
}

/**
 * How many requests this client still accepts, read by filling past the cap and counting refusals.
 *
 * A macrotask rather than a flush: the cap answers with a rejected promise, and a microtask drain
 * races the rejection against the assertion that reads it.
 */
async function acceptedRequestCount(client: {
  sendRequest: (method: string, params?: unknown) => Promise<unknown>
}): Promise<number> {
  const attempts = BRIDGE_MAX_PENDING_REQUESTS + 4
  const refusals: string[] = []
  for (let index = 0; index < attempts; index += 1) {
    void client.sendRequest('git.status', { index }).catch((error: Error) => {
      refusals.push(error.name)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  return attempts - refusals.filter((name) => name === 'BridgeClientCapExceededError').length
}

describe('a request frame the page cannot serialize', () => {
  it('rejects as a send failure and says so on the diagnostic channel', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()

    const rejection = await pair.client.sendRequest('git.status', cyclicParams()).then(
      () => null,
      (error: unknown) => error
    )

    // The name rather than the text: what matters is that the caller is told the frame never left,
    // by the same error every other undelivered frame raises.
    expect(rejection instanceof Error ? rejection.name : String(rejection)).toBe(
      'BridgeSendFailedError'
    )
    expect(pair.diagnostics.map((entry) => entry.kind)).toEqual(['send-failed'])
    // Nothing reached the shell, and nothing was left half-sent for it to answer.
    expect(pair.readToShell().filter((message) => message.type === 'request')).toEqual([])
  })

  it('gives the in-flight slot back, so the client is not one request poorer', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    void pair.client.sendRequest('git.status', cyclicParams()).catch(() => undefined)

    // The whole cap, not one short of it. 63 here is the defect: the id opened for the frame that
    // never serialized is still in the pending map, and nothing will ever settle it.
    expect(await acceptedRequestCount(pair.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
  })

  it('accepts the same count on a client that sent no such frame', async () => {
    // The control. Without it the case above also passes against a client whose cap moved, which is
    // a different change with the same number in it.
    const pair = createFakeBridgePortPair()
    await pair.flush()
    expect(await acceptedRequestCount(pair.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
  })
})
