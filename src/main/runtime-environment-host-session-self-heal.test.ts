import { describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../shared/execution-host'
import { selfHealRuntimeHostWorkspaceSessions } from './runtime-environment-host-session-self-heal'

function environment(id: string): KnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    preferredEndpointId: `ws-${id}`
  }
}

const PRESENT = '11111111-1111-4111-8111-111111111111'
const ABSENT = '83a64365-660b-4723-890e-9e557eb45e40'

function makeStore(removedHostIds: readonly string[] = []) {
  const pruneOrphanedRuntimeHostWorkspaceSessions = vi.fn(
    (_knownEnvironmentIds: ReadonlySet<string>): readonly string[] => removedHostIds
  )
  return {
    store: { pruneOrphanedRuntimeHostWorkspaceSessions },
    pruneOrphanedRuntimeHostWorkspaceSessions
  }
}

describe('runtime host workspace session self-heal', () => {
  it('prunes with the set of currently-saved env ids and logs one diagnostic line', () => {
    const { store, pruneOrphanedRuntimeHostWorkspaceSessions } = makeStore([
      toRuntimeExecutionHostId(ABSENT)
    ])
    const log = vi.fn()

    selfHealRuntimeHostWorkspaceSessions({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [environment(PRESENT)],
      environmentStoreExists: () => true,
      log
    })

    expect(pruneOrphanedRuntimeHostWorkspaceSessions).toHaveBeenCalledTimes(1)
    const knownIds = pruneOrphanedRuntimeHostWorkspaceSessions.mock.calls[0]![0]
    expect(knownIds.has(PRESENT)).toBe(true)
    expect(knownIds.has(ABSENT)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain(toRuntimeExecutionHostId(ABSENT))
  })

  it('does not log when nothing was pruned', () => {
    const { store, pruneOrphanedRuntimeHostWorkspaceSessions } = makeStore([])
    const log = vi.fn()

    selfHealRuntimeHostWorkspaceSessions({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [environment(PRESENT)],
      environmentStoreExists: () => true,
      log
    })

    expect(pruneOrphanedRuntimeHostWorkspaceSessions).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('skips pruning entirely when the environment registry file is absent', () => {
    // Why: a MISSING file must not be read as "zero saved environments" and wipe
    // every runtime host's terminal session (deleting a host session is not
    // recoverable). listEnvironments returns [] for a missing file, so the
    // existence guard is what prevents the wipe.
    const { store, pruneOrphanedRuntimeHostWorkspaceSessions } = makeStore([
      toRuntimeExecutionHostId(ABSENT)
    ])
    const listKnownEnvironments = vi.fn(() => [] as KnownRuntimeEnvironment[])

    selfHealRuntimeHostWorkspaceSessions({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments,
      environmentStoreExists: () => false
    })

    expect(pruneOrphanedRuntimeHostWorkspaceSessions).not.toHaveBeenCalled()
    expect(listKnownEnvironments).not.toHaveBeenCalled()
  })

  it('prunes all runtime partitions when the registry exists but is genuinely empty', () => {
    const { store, pruneOrphanedRuntimeHostWorkspaceSessions } = makeStore([])

    selfHealRuntimeHostWorkspaceSessions({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [],
      environmentStoreExists: () => true
    })

    expect(pruneOrphanedRuntimeHostWorkspaceSessions).toHaveBeenCalledTimes(1)
    const knownIds = pruneOrphanedRuntimeHostWorkspaceSessions.mock.calls[0]![0]
    expect(knownIds.size).toBe(0)
  })

  it('fails soft when the environment registry cannot be read', () => {
    const { store, pruneOrphanedRuntimeHostWorkspaceSessions } = makeStore([
      toRuntimeExecutionHostId(ABSENT)
    ])

    selfHealRuntimeHostWorkspaceSessions({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => {
        throw new Error('invalid registry')
      },
      environmentStoreExists: () => true
    })

    expect(pruneOrphanedRuntimeHostWorkspaceSessions).not.toHaveBeenCalled()
  })
})
