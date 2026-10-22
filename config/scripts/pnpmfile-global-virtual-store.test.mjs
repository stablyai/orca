import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  FORCE_IN_CI_ENV,
  GLOBAL_VIRTUAL_STORE_ENV: STORE_ENV,
  usesGlobalVirtualStore,
  hooks
} = require('../pnpmfile.cjs')

describe('usesGlobalVirtualStore', () => {
  const cases = [
    // [env, expected]; platform-independent, so Windows standard users get it too.
    [{}, true],
    [{ [STORE_ENV]: '1' }, true],
    [{ [STORE_ENV]: '0' }, false],
    [{ [STORE_ENV]: 'yes' }, true],
    [{ CI: 'true' }, false],
    [{ CI: '1' }, false],
    [{ GITHUB_ACTIONS: 'true' }, false],
    [{ CI: 'true', [STORE_ENV]: '1' }, false],
    [{ CI: 'true', [FORCE_IN_CI_ENV]: '1' }, true],
    [{ GITHUB_ACTIONS: 'true', [FORCE_IN_CI_ENV]: '1' }, true],
    [{ [FORCE_IN_CI_ENV]: '1', [STORE_ENV]: '0' }, false],
    [{ CI: 'false' }, true],
    [{ CI: '0' }, true]
  ]
  it.each(cases)('env %j -> %s', (env, expected) => {
    expect(usesGlobalVirtualStore({ env })).toBe(expected)
  })
})

describe('config/pnpmfile.cjs updateConfig', () => {
  it('sets the store from the policy, so pnpm-workspace.yaml never has to', () => {
    const config = hooks.updateConfig({})
    expect(config.enableGlobalVirtualStore).toBe(usesGlobalVirtualStore())
  })
})
