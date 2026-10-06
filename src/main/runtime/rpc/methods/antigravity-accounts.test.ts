import { expect, it, vi } from 'vitest'
const run = vi.hoisted(() => vi.fn())
vi.mock('../../../antigravity/native-account-host', () => ({ runAntigravityAccountOperation: run }))
import { ANTIGRAVITY_ACCOUNT_METHODS } from './antigravity-accounts'
it.each([
  ['accounts.antigravityList', 'List', { runtime: 'wsl', wslDistro: null }],
  ['accounts.antigravityAddCurrent', 'AddCurrent', { runtime: 'host' }]
])('routes %s to the owning account dispatcher', async (name, action, target) => {
  const method = ANTIGRAVITY_ACCOUNT_METHODS.find((entry) => entry.name === name)
  expect(method).toBeDefined()
  // Params are parsed at the real RPC schema boundary; the handler ignores context.
  const params = method?.params?.parse(target)
  if (!method) {
    throw new Error('Missing Antigravity method')
  }
  await Reflect.apply(method.handler, undefined, [params, undefined])
  expect(run).toHaveBeenLastCalledWith(target, action)
})
