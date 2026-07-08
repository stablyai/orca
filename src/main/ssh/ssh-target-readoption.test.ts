import { describe, it, expect } from 'vitest'
import {
  buildRemovedSshTargetTombstone,
  readoptOrphanedWorkspacesForTarget
} from './ssh-target-readoption'
import type { Store } from '../persistence'
import type { RemovedSshTargetTombstone, SshTarget } from '../../shared/ssh-types'

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

/** Minimal in-memory store exposing only what re-adoption touches. */
function makeFakeStore(tombstones: RemovedSshTargetTombstone[]) {
  const reassigned: { oldId: string; newId: string }[] = []
  let current = [...tombstones]
  const store = {
    getRemovedSshTargetTombstones: () => [...current],
    removeRemovedSshTargetTombstone: (oldTargetId: string) => {
      current = current.filter((t) => t.oldTargetId !== oldTargetId)
    },
    reassignSshTargetId: (oldTargetId: string, newTargetId: string) => {
      reassigned.push({ oldId: oldTargetId, newId: newTargetId })
      return 1
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
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: 'devbox', host: 'now.example.com' })
    )
    expect(count).toBe(1)
    expect(fake.reassigned).toEqual([{ oldId: 'ssh-old', newId: 'ssh-new' }])
    expect(fake.remaining()).toHaveLength(0) // tombstone consumed
  })

  it('re-adopts on matching host+user+port when no alias', () => {
    const fake = makeFakeStore([tombstone()])
    const count = readoptOrphanedWorkspacesForTarget(fake.store, makeTarget())
    expect(count).toBe(1)
    expect(fake.reassigned).toEqual([{ oldId: 'ssh-old', newId: 'ssh-new' }])
  })

  it('does not re-adopt when identity differs', () => {
    const fake = makeFakeStore([tombstone({ host: 'other.example.com', username: 'root' })])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ host: 'dev.example.com', username: 'tim' })
    )
    expect(count).toBe(0)
    expect(fake.reassigned).toEqual([])
    expect(fake.remaining()).toHaveLength(1) // tombstone left for a future match
  })

  it('matches host/user/port case-insensitively', () => {
    const fake = makeFakeStore([tombstone({ host: 'Dev.Example.COM', username: 'Tim' })])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ host: 'dev.example.com', username: 'tim' })
    )
    expect(count).toBe(1)
  })

  it('does not match alias against a different host tuple', () => {
    // Different alias AND different tuple => no match.
    const fake = makeFakeStore([
      tombstone({ configHost: 'prod', host: 'prod.example.com', username: 'root' })
    ])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: 'devbox', host: 'dev.example.com', username: 'tim' })
    )
    expect(count).toBe(0)
  })

  it('is a no-op when there are no tombstones', () => {
    const fake = makeFakeStore([])
    expect(readoptOrphanedWorkspacesForTarget(fake.store, makeTarget())).toBe(0)
  })

  it('does NOT re-adopt across two different aliases that share host+user+port', () => {
    // prod-deploy removed; prod-admin re-added — same box, different alias.
    // These are deliberately distinct targets and must not steal workspaces.
    const fake = makeFakeStore([
      tombstone({ configHost: 'prod-deploy', host: 'prod.example.com', username: 'deploy' })
    ])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: 'prod-admin', host: 'prod.example.com', username: 'deploy' })
    )
    expect(count).toBe(0)
    expect(fake.reassigned).toEqual([])
    expect(fake.remaining()).toHaveLength(1) // tombstone preserved
  })

  it('does NOT re-adopt a different account/port on the same host (implicit alias)', () => {
    // Manual adds default configHost to host, so both carry configHost === host.
    // That is NOT a real alias — matching on it alone would ignore port/username
    // and reattach workspaces to the wrong SSH account on the same machine.
    const fake = makeFakeStore([
      tombstone({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
    ])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 2222,
        username: 'bob'
      })
    )
    expect(count).toBe(0)
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
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 22,
        username: 'alice'
      })
    )
    expect(count).toBe(1)
  })

  it('still re-adopts via tuple when the re-added target has no alias', () => {
    // Manual re-add (no configHost) of a host that was config-managed: fall back
    // to the tuple since one side lacks an alias to distinguish it.
    const fake = makeFakeStore([
      tombstone({ configHost: 'devbox', host: 'dev.example.com', username: 'tim' })
    ])
    const count = readoptOrphanedWorkspacesForTarget(
      fake.store,
      makeTarget({ configHost: undefined, host: 'dev.example.com', username: 'tim' })
    )
    expect(count).toBe(1)
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
