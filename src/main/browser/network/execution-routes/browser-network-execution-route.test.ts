import { describe, expect, it } from 'vitest'
import {
  browserNetworkExecutionHostKey,
  parseBrowserNetworkExecutionHostKey,
  resolveNativeBrowserNetworkExecutionRoute
} from './browser-network-execution-route'

describe('browser network execution route', () => {
  it('uses structural keys for delimiter-containing execution-host identities', () => {
    const first = browserNetworkExecutionHostKey({
      kind: 'ssh',
      targetId: 'a:b',
      providerEpoch: 'c',
      connectionGeneration: 2
    })
    const second = browserNetworkExecutionHostKey({
      kind: 'ssh',
      targetId: 'a',
      providerEpoch: 'b:c',
      connectionGeneration: 2
    })

    expect(first).not.toBe(second)
    expect(
      browserNetworkExecutionHostKey({
        kind: 'wsl',
        runtimeId: 'runtime-a',
        revision: 2,
        distro: 'Ubuntu:Dev'
      })
    ).toBe('["wsl","runtime-a",2,"Ubuntu:Dev"]')
  })

  it('accepts only this runtime native revision', () => {
    const route = resolveNativeBrowserNetworkExecutionRoute({
      executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 2 },
      runtimeId: 'runtime-a',
      runtimeRevision: 2
    })

    expect(route.key).toBe('["native","runtime-a",2]')
    expect(route.whenInvalidated).toBeUndefined()
    expect(() =>
      resolveNativeBrowserNetworkExecutionRoute({
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
        runtimeId: 'runtime-a',
        runtimeRevision: 2
      })
    ).toThrow('browser_tunnel_execution_host_mismatch')
  })

  it('round trips only canonical execution-host keys', () => {
    const host = {
      kind: 'ssh' as const,
      targetId: 'ssh-a',
      providerEpoch: 'provider-a',
      connectionGeneration: 3
    }
    const key = browserNetworkExecutionHostKey(host)

    expect(parseBrowserNetworkExecutionHostKey(key)).toEqual(host)
    const wsl = {
      kind: 'wsl' as const,
      runtimeId: 'runtime-a',
      revision: 4,
      distro: 'Ubuntu'
    }
    expect(parseBrowserNetworkExecutionHostKey(browserNetworkExecutionHostKey(wsl))).toEqual(wsl)
    for (const malformed of [
      'ssh:ssh-a:provider-a:3',
      ' ["ssh","ssh-a","provider-a",3]',
      '["ssh","ssh-a","provider-a",3,4]',
      '["native","runtime-a",-1]',
      '["wsl","runtime-a",4,""]',
      '["wsl","runtime-a",4,"Ubuntu","extra"]'
    ]) {
      expect(() => parseBrowserNetworkExecutionHostKey(malformed)).toThrow(
        'browser_tunnel_execution_host_key_invalid'
      )
    }
  })
})
