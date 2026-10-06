import { afterEach, expect, vi } from 'vitest'
import type { RpcAnyMethodDeclaration } from './core'

const unusedDefaultRpcMethods = vi.hoisted(() => {
  const methods: RpcAnyMethodDeclaration[] = []
  const consumption = { count: 0 }
  methods[Symbol.iterator] = (): ArrayIterator<RpcAnyMethodDeclaration> => {
    consumption.count += 1
    throw new Error('Explicit-registry tests must not consume the default RPC manifest')
  }
  return { methods, consumption }
})

vi.mock('./methods', () => ({ ALL_RPC_METHODS: unusedDefaultRpcMethods.methods }))

afterEach(() => {
  try {
    expect(unusedDefaultRpcMethods.consumption.count).toBe(0)
  } finally {
    unusedDefaultRpcMethods.consumption.count = 0
  }
})
