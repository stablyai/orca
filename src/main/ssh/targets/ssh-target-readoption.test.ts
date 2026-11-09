import { describe, it, expect } from 'vitest'
import { readoptOrphanedWorkspacesForTarget } from './ssh-target-readoption'
import type { Store } from '../../persistence/loading-store/store'
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
})
