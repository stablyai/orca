import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Repo } from '../../../../../shared/repo-types'
import '../../dispatcher'

import './repo'
import { makeRequest, repoDispatcher } from './repo-rpc.test-fixture'
import '../../../../../shared/protocol-version'

import '../../../../../shared/worktree-runtime-capabilities'
import '../../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import '../../../../../shared/repo-search-limits'
import '../../../../../shared/ssh-target-management'

describe('repo RPC methods', () => {
  it('answers repo.list snapshot reads unchanged while the repos stay the same', async () => {
    let repos: Repo[] = [
      { id: 'repo-1', path: '/r', displayName: 'api', badgeColor: '#fff', addedAt: 1 }
    ]
    const dispatcher = repoDispatcher({
      getRuntimeId: () => 'test-runtime',
      listVisibleRepos: () => repos
    })
    const snapshotIdOf = (reply: unknown) =>
      z.object({ snapshotId: z.string() }).parse(reply).snapshotId
    const result = async (params?: unknown) => {
      const response = await dispatcher.dispatch(makeRequest('repo.list', params))
      return response.ok ? response.result : null
    }

    const legacy = await result()
    const first = await result({ afterSnapshotId: null })
    const repeat = await result({ afterSnapshotId: snapshotIdOf(first) })
    repos = [{ id: 'repo-1', path: '/r', displayName: 'api-2', badgeColor: '#fff', addedAt: 1 }]
    const changed = await result({ afterSnapshotId: snapshotIdOf(first) })

    expect(legacy).toEqual({ repos: [expect.objectContaining({ displayName: 'api' })] })
    expect(first).toEqual({
      repos: [expect.objectContaining({ displayName: 'api' })],
      snapshotId: snapshotIdOf(first)
    })
    expect(repeat).toEqual({ unchanged: true, snapshotId: snapshotIdOf(first) })
    expect(changed).toMatchObject({ repos: [expect.objectContaining({ displayName: 'api-2' })] })
    expect(snapshotIdOf(changed)).not.toBe(snapshotIdOf(first))
  })
})
