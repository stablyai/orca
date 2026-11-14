import { afterEach, describe, expect, it } from 'vitest'

import { createFakeBridgePortPair as createPair } from '../test-support/bridge-port-pair-test-harness'

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

// Failed serialization must release the request slot.

function cyclicParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { worktree: 'id:wt-1' }
  params.self = params
  return params
}

const unserializable = [{ name: 'cycle', params: cyclicParams }]

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
})

afterEach(closeResources)
