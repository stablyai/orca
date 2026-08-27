import { describe, expect, it } from 'vitest'
import {
  browserAuthorityExecutionHostStorageIdentity,
  browserNetworkExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity,
  legacyBrowserNetworkExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'

const storageKey = 'a'.repeat(64)
const otherStorageKey = 'b'.repeat(64)

describe('browserNetworkExecutionHostStorageIdentity', () => {
  it('ignores the per-boot components the route key fences on', () => {
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
        storageKey
      )
    ).toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 2 },
        storageKey
      )
    )
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 1, distro: 'Ubuntu' },
        storageKey
      )
    ).toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 2, distro: 'Ubuntu' },
        storageKey
      )
    )
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: 'ssh-1', providerEpoch: 'epoch-a', connectionGeneration: 1 },
        storageKey
      )
    ).toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: 'ssh-1', providerEpoch: 'epoch-b', connectionGeneration: 2 },
        storageKey
      )
    )
  })

  // Why: runtimeId is a per-process randomUUID, so hashing it minted a fresh partition on
  // every remote-server restart and dropped the user's cookies.
  it('survives the authority runtime restarting under a new runtimeId', () => {
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
        storageKey
      )
    ).toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-b', revision: 9 },
        storageKey
      )
    )
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 1, distro: 'Ubuntu' },
        storageKey
      )
    ).toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-b', revision: 9, distro: 'Ubuntu' },
        storageKey
      )
    )
  })

  it('separates every boundary that changes storage or egress', () => {
    const identities = [
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
        storageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
        otherStorageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 1, distro: 'Ubuntu' },
        storageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 1, distro: 'Debian' },
        storageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'runtime-a', revision: 1, distro: 'Ubuntu' },
        otherStorageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: 'ssh-1', providerEpoch: 'epoch-a', connectionGeneration: 1 },
        storageKey
      ),
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: 'ssh-2', providerEpoch: 'epoch-a', connectionGeneration: 1 },
        storageKey
      )
    ]

    expect(new Set(identities).size).toBe(identities.length)
  })

  it('keeps delimiter-bearing components structurally distinct', () => {
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'a', revision: 1, distro: 'b","c' },
        'a'
      )
    ).not.toBe(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'a', revision: 1, distro: 'c' },
        'a","b'
      )
    )
  })

  // Why: these strings are hashed into persisted partition names, and the pre-migration forms
  // name the jar adoption must find -- changing either relocates or strands the user's cookies.
  it('pins the storage identity of every host kind, current and pre-migration', () => {
    const tag = '"orca-browser-execution-host-storage",1'

    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'r', revision: 1 },
        storageKey
      )
    ).toBe(`[${tag},"authority","${storageKey}"]`)
    expect(browserAuthorityExecutionHostStorageIdentity(storageKey)).toBe(
      `[${tag},"authority","${storageKey}"]`
    )
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'wsl', runtimeId: 'r', revision: 1, distro: 'Ubuntu' },
        storageKey
      )
    ).toBe(`[${tag},"authority-wsl","${storageKey}","Ubuntu"]`)
    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: 'ssh-1', providerEpoch: 'e', connectionGeneration: 1 },
        storageKey
      )
    ).toBe(`[${tag},"ssh","ssh-1"]`)

    expect(legacyBrowserNativeExecutionHostStorageIdentity('r')).toBe(`[${tag},"native","r"]`)
    expect(
      legacyBrowserNetworkExecutionHostStorageIdentity({
        kind: 'native',
        runtimeId: 'r',
        revision: 1
      })
    ).toBe(`[${tag},"native","r"]`)
    expect(
      legacyBrowserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'r',
        revision: 1,
        distro: 'Ubuntu'
      })
    ).toBe(`[${tag},"wsl","r","Ubuntu"]`)
    expect(
      legacyBrowserNetworkExecutionHostStorageIdentity({
        kind: 'ssh',
        targetId: 'ssh-1',
        providerEpoch: 'e',
        connectionGeneration: 1
      })
    ).toBe(`[${tag},"ssh","ssh-1"]`)
  })

  // Why: adoption trusts the pre-migration name, so distros sharing one would hand a
  // second distro the first one's logged-in jar.
  it('keeps pre-migration WSL distros apart on one runtime', () => {
    expect(
      legacyBrowserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'r',
        revision: 1,
        distro: 'Ubuntu'
      })
    ).not.toBe(
      legacyBrowserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'r',
        revision: 1,
        distro: 'Debian'
      })
    )
  })

  // Why: the kind tag is the only thing keeping an SSH record out of the paired server's
  // own jar when the two records happen to carry the same key.
  it('never lets an SSH target share the paired server machine identity', () => {
    const shared = 'ssh-1700000000-aaa111'

    expect(
      browserNetworkExecutionHostStorageIdentity(
        { kind: 'ssh', targetId: shared, providerEpoch: 'e', connectionGeneration: 1 },
        shared
      )
    ).not.toBe(browserAuthorityExecutionHostStorageIdentity(shared))
  })

  it('is never mistaken for a route fencing key', () => {
    const host = {
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 7
    } as const

    expect(browserNetworkExecutionHostStorageIdentity(host, storageKey)).not.toBe(
      browserNetworkExecutionHostKey(host)
    )
  })
})
