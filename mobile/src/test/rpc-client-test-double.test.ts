import { describe, expect, it } from 'vitest'
import { createRpcClientTestDouble } from './rpc-client-test-double'

describe('createRpcClientTestDouble', () => {
  it('defaults to a reachable connected state', () => {
    const client = createRpcClientTestDouble()

    expect(client.getState()).toBe('connected')
    expect(client.getLastConnectedAt()).not.toBeNull()
  })
})
