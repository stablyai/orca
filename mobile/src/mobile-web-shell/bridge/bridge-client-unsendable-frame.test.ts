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

// Keep serialization inside sendFrame’s catch: cyclic params, BigInt or throwing toJSON must abandon the opened request id and report send failure, never leak one of 64 slots.

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

    expect(rejection instanceof Error ? rejection.name : String(rejection)).toBe(
      'BridgeSendFailedError'
    )
    expect(pair.diagnostics.map((entry) => entry.kind)).toEqual(['send-failed'])
    expect(pair.readToShell().filter((message) => message.type === 'request')).toEqual([])
  })

  it.each(unserializable)(
    'restores the whole request capacity after $name fails',
    async ({ params }) => {
      const pair = createFakeBridgePortPair()
      await pair.flush()
      void pair.client.sendRequest('git.status', params()).catch(() => undefined)

      // Assert all 64 slots remain usable; leaking the unserializable request leaves only 63.
      const clean = createFakeBridgePortPair()
      await clean.flush()
      expect(await acceptedRequestCount(clean.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
      expect(await acceptedRequestCount(pair.client)).toBe(BRIDGE_MAX_PENDING_REQUESTS)
    }
  )
})

afterEach(closeResources)
