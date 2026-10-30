import { describe, it, expect } from 'vitest'
import {
  buildRemovedSshTargetTombstone,
  readoptOrphanedWorkspacesForTarget
} from './ssh-target-readoption'
import type { Store } from '../../persistence'
import type { RemovedSshTargetTombstone, SshTarget } from '../../../shared/ssh-types'

function makeTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-new',
    label: 'Dev box',
    host: 'dev.example.com',
    port: 22,
    username: 'tim',
    ...overrides
  }
}

function makeFakeStore(tombstones: RemovedSshTargetTombstone[]) {
  const reassigned: { oldId: string; newId: string }[] = []
  let current = [...tombstones]
  const store = {
    getRemovedSshTargetTombstones: () => [...current],
    releaseRemovedSshTargetTombstone: (oldTargetId: string) => {
      current = current.filter((t) => t.oldTargetId !== oldTargetId)
    },
    reassignSshTargetId: (oldTargetId: string, newTargetId: string) => {
      reassigned.push({ oldId: oldTargetId, newId: newTargetId })
      return ['repo-1']
    }
  } as unknown as Store
  return { store, reassigned, remaining: () => current }
}

const tombstone = (
  overrides: Partial<RemovedSshTargetTombstone> = {}
): RemovedSshTargetTombstone => ({
  oldTargetId: 'ssh-old',
  host: 'dev.example.com',
  port: 22,
  username: 'tim',
  label: 'Dev box',
  removedAt: 1,
  ...overrides
})

describe('readoptOrphanedWorkspacesForTarget', () => {
  it('re-adopts on matching configHost alias', () => {
    const fake = makeFakeStore([tombstone({ configHost: 'devbox', host: 'changed.example.com' })])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: 'devbox', host: 'now.example.com' })
    )
    expect(readoptions).toEqual([
      { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['repo-1'] }
    ])
    expect(fake.reassigned).toEqual([{ oldId: 'ssh-old', newId: 'ssh-new' }])
    expect(fake.remaining()).toHaveLength(0)
  })

  it('re-adopts on matching host+user+port when no alias', () => {
    const fake = makeFakeStore([tombstone()])
    const readoptions = readoptOrphanedWorkspacesForTarget(fake.store, makeTarget())
    expect(readoptions).toEqual([
      { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['repo-1'] }
    ])
    expect(fake.reassigned).toEqual([{ oldId: 'ssh-old', newId: 'ssh-new' }])
  })

  it('does not re-adopt when identity differs', () => {
    const fake = makeFakeStore([tombstone({ host: 'other.example.com', username: 'root' })])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ host: 'dev.example.com', username: 'tim' })
    )
    expect(readoptions).toEqual([])
    expect(fake.reassigned).toEqual([])
    expect(fake.remaining()).toHaveLength(1)
  })

  it('matches host/user/port case-insensitively', () => {
    const fake = makeFakeStore([tombstone({ host: 'Dev.Example.COM', username: 'Tim' })])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ host: 'dev.example.com', username: 'tim' })
    )
    expect(readoptions).toHaveLength(1)
  })

  it('is a no-op when there are no tombstones', () => {
    const fake = makeFakeStore([])
    expect(readoptOrphanedWorkspacesForTarget(fake.store, makeTarget())).toEqual([])
  })

  it('does NOT re-adopt across two different aliases that share host+user+port', () => {
    // Distinct aliases must not steal each other's workspaces even on the same endpoint.
    const fake = makeFakeStore([
      tombstone({ configHost: 'prod-deploy', host: 'prod.example.com', username: 'deploy' })
    ])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: 'prod-admin', host: 'prod.example.com', username: 'deploy' })
    )
    expect(readoptions).toEqual([])
    expect(fake.reassigned).toEqual([])
    expect(fake.remaining()).toHaveLength(1)
  })

  it('does NOT re-adopt a different account/port on the same host (implicit alias)', () => {
    // Manual configHost=host is no alias; require account/port matching to avoid attaching to the wrong account.
    const fake = makeFakeStore([
      tombstone({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
    ])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 2222,
        username: 'bob'
      })
    )
    expect(readoptions).toEqual([])
    expect(fake.reassigned).toEqual([])
  })

  it('re-adopts the same account/host/port even with implicit configHost === host', () => {
    const fake = makeFakeStore([
      tombstone({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
    ])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
    )
    expect(readoptions).toHaveLength(1)
  })

  it('still re-adopts via tuple when the re-added target has no alias', () => {
    // One side lacks a real alias, so endpoint identity may match a previously config-managed host.
    const fake = makeFakeStore([
      tombstone({ configHost: 'devbox', host: 'dev.example.com', username: 'tim' })
    ])
    const readoptions = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: undefined, host: 'dev.example.com', username: 'tim' })
    )
    expect(readoptions).toHaveLength(1)
  })
})

describe('buildRemovedSshTargetTombstone', () => {
  it('captures identity fields and omits configHost when absent', () => {
    const t = buildRemovedSshTargetTombstone(makeTarget(), 123)
    expect(t).toEqual({
      oldTargetId: 'ssh-new',
      host: 'dev.example.com',
      port: 22,
      username: 'tim',
      label: 'Dev box',
      removedAt: 123
    })
    expect('configHost' in t).toBe(false)
  })

  it('includes configHost when present', () => {
    const t = buildRemovedSshTargetTombstone(makeTarget({ configHost: 'devbox' }), 1)
    expect(t.configHost).toBe('devbox')
  })
})
