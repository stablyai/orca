import { describe, expect, it } from 'vitest'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { ALL_RPC_METHODS } from './rpc-method-registry'
import { DEFAULT_LAZY_RPC_METHOD_GROUPS, EAGER_RPC_METHODS } from './eager-rpc-method-registry'

describe('lazy RPC method registry partition', () => {
  it('partitions ALL_RPC_METHODS across eager and lazy groups with matching routing and streaming metadata', async () => {
    const eagerNames = new Set(eraseRpcMethods(EAGER_RPC_METHODS).map((m) => m.name))
    const allNames = new Set(eraseRpcMethods(ALL_RPC_METHODS).map((m) => m.name))
    const seenLazyNames = new Set<string>()

    for (const group of DEFAULT_LAZY_RPC_METHOD_GROUPS) {
      const loaded = eraseRpcMethods(await group.load())
      const declaredStreaming = new Set(group.streamingNames ?? [])
      for (const method of loaded) {
        expect(eagerNames.has(method.name)).toBe(false)
        expect(seenLazyNames.has(method.name)).toBe(false)
        expect(group.matches(method.name)).toBe(true)
        expect(declaredStreaming.has(method.name)).toBe(isStreamingMethod(method))
        seenLazyNames.add(method.name)
      }
    }

    const union = new Set([...eagerNames, ...seenLazyNames])
    expect(union).toEqual(allNames)
  })
})
