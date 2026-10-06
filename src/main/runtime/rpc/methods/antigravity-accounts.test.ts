import { expect, it, vi } from 'vitest'
import { eraseRpcMethods } from '../core'
const run = vi.hoisted(() => vi.fn())
vi.mock('../../../antigravity/native-account-host', () => ({ runAntigravityAccountOperation: run }))
import { ANTIGRAVITY_ACCOUNT_METHODS } from './antigravity-accounts'
it.each([
  ['accounts.antigravityList', 'List', { runtime: 'wsl', wslDistro: null }],
  ['accounts.antigravityAddCurrent', 'AddCurrent', { runtime: 'host' }]
])('routes %s to the owning account dispatcher', async (name, action, target) => {
  const method = eraseRpcMethods(ANTIGRAVITY_ACCOUNT_METHODS).find((entry) => entry.name === name)
  expect(method).toBeDefined()
  // Params are parsed at the real RPC schema boundary; the handler ignores context.
  const params = method?.params?.parse(target)
  if (!method) {
    throw new Error('Missing Antigravity method')
  }
  await method.handler(params, {
    get runtime(): never {
      throw new Error('Antigravity account handlers must not access the RPC runtime')
    }
  })
  expect(run).toHaveBeenLastCalledWith(target, action)
})
