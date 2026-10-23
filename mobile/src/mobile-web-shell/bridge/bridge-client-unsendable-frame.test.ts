import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge-caps'
import { createFakeBridgePortPair as createPair } from './bridge-port-pair-test-harness'

const resources = new Set<ReturnType<typeof createPair>>()
function createFakeBridgePortPair(
  ...args: Parameters<typeof createPair>
): ReturnType<typeof createPair> {
  const resource = createPair(...args)
  resources.add(resource)
  return resource
}
function closeResources(): void {
  for (const resource of resources) {
    resource.client.close()
    resource.host.dispose()
  }
  resources.clear()
}

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
  await Promise.resolve()
  await Promise.resolve()
  return attempts - refusals.filter((name) => name === 'BridgeClientCapExceededError').length
}

const unserializable = [
  { name: 'cycle', params: cyclicParams },
  { name: 'BigInt', params: () => ({ count: 1n }) },
  {
    name: 'throwing toJSON',
    params: () => ({
      toJSON() {
        throw new Error('cannot serialize')
      }
    })
  }
]

describe('a request frame the page cannot serialize', () => {
  it.each(unserializable)('rejects $name as a send failure and reports it', async ({ params }) => {
    const pair = createFakeBridgePortPair()
    await pair.flush()

    const rejection = await pair.client.sendRequest('git.status', params()).then(
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

  it.each(unserializable)(
    'restores the whole request capacity after $name fails',
    async ({ params }) => {
      const pair = createFakeBridgePortPair()
      await pair.flush()
      void pair.client.sendRequest('git.status', params()).catch(() => undefined)

      // The whole cap, not one short of it. 63 here is the defect: the id opened for the frame that
      // never serialized is still in the pending map, and nothing will ever settle it.
      const clean = createFakeBridgePortPair()
      await clean.flush()
      expect(await acceptedRequestCount(clean.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
      expect(await acceptedRequestCount(pair.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
    }
  )
})

afterEach(closeResources)
