import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshRemoteRuntimeResolution } from '../../shared/ssh-types'

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.0' })
}))
vi.mock('./ssh-remote-runtime-telemetry', () => ({ trackSshRemoteRuntimeResolved: vi.fn() }))

import {
  RelayRuntimeLadderRun,
  remoteRuntimeUnavailableError,
  type RelayRuntimeDecisionStore
} from './ssh-relay-runtime-resolution'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 31 } }

function memoryStore(): RelayRuntimeDecisionStore & { value?: SshRemoteRuntimeResolution } {
  const store: RelayRuntimeDecisionStore & { value?: SshRemoteRuntimeResolution } = {
    read: () => store.value,
    write: (_id, resolution) => {
      store.value = resolution
    }
  }
  return store
}

function rememberedNoexecRun(store: RelayRuntimeDecisionStore): RelayRuntimeLadderRun {
  const run = new RelayRuntimeLadderRun('ssh-1', store)
  run.host = getRemoteHostPlatform('linux-x64')
  run.facts = facts
  run.refused('A', 'noexec')
  return run
}

describe('RelayRuntimeLadderRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists a rung A refusal and replays it only under a matching key', () => {
    const store = memoryStore()
    rememberedNoexecRun(store).settle('D')
    expect(store.value).toMatchObject({ rung: 'D', pinnedRefusal: 'noexec', glibc: '2.31' })
    const replay = new RelayRuntimeLadderRun('ssh-1', store)
    expect(replay.persistedPinnedRefusal(facts)).toBe('noexec')
    expect(replay.persistedPinnedRefusal({ ...facts, glibc: { major: 2, minor: 35 } })).toBeNull()
  })

  it('drops a remembered noexec once rung C self-tests addons from the same tree', () => {
    const store = memoryStore()
    const run = rememberedNoexecRun(store)
    run.selfTest = 'passed'
    run.settle('C')
    expect(store.value?.rung).toBe('C')
    expect(store.value).not.toHaveProperty('pinnedRefusal')
  })

  it('keeps a remembered noexec when rung C launched warm without a self-test', () => {
    const store = memoryStore()
    rememberedNoexecRun(store).settle('C')
    expect(store.value?.pinnedRefusal).toBe('noexec')
  })

  it('drops a replayed noexec at rung D, so a remounted home is re-proved next connect', () => {
    const store = memoryStore()
    const run = new RelayRuntimeLadderRun('ssh-1', store)
    run.host = getRemoteHostPlatform('linux-x64')
    run.facts = facts
    run.refused('A', 'noexec', true)
    run.refused('C', 'host_node_missing')
    run.settle('D')
    expect(store.value?.rung).toBe('D')
    expect(store.value).not.toHaveProperty('pinnedRefusal')
    expect(remoteRuntimeUnavailableError(run)).toMatchObject({ data: { reason: 'home_noexec' } })
  })

  it('reports a remembered noexec at rung D without advising a host Node install', () => {
    const run = new RelayRuntimeLadderRun('ssh-1', null)
    run.host = getRemoteHostPlatform('linux-x64')
    run.facts = facts
    run.refused('A', 'noexec', true)
    run.refused('B', 'runtime_unavailable')
    run.refused('C', 'host_node_missing')
    const error = remoteRuntimeUnavailableError(run)
    expect(error.message).toContain('earlier connect found the home directory mounted noexec')
    expect(error.message).not.toContain('Install Node.js')
    expect(error).toMatchObject({ data: { reason: 'home_noexec' } })
  })

  it('still advises a host Node when rung A refused for another reason', () => {
    const run = new RelayRuntimeLadderRun('ssh-1', null)
    run.refused('A', 'libc_floor')
    run.refused('C', 'host_node_missing')
    expect(remoteRuntimeUnavailableError(run).message).toContain('Install Node.js 18+')
  })
})
