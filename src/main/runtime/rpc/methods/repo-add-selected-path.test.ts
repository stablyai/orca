import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeRequest, repoDispatcher } from './repo-rpc.test-fixture'

describe('repo.add checkout handoff', () => {
  it('returns the host-resolved picked folder even when registration returns the primary repo', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-add-checkout-')))
    try {
      const linked = join(root, 'linked')
      const selected = join(linked, 'packages')
      await mkdir(selected, { recursive: true })
      const alias = join(root, 'alias')
      await symlink(linked, alias, 'junction')
      const repo: Repo = {
        id: 'repo-1',
        path: join(root, 'primary'),
        displayName: 'project',
        badgeColor: '#fff',
        addedAt: 1,
        externalWorktreeVisibility: 'hide'
      }
      const dispatcher = repoDispatcher({
        getRuntimeId: () => 'test-runtime',
        addRepo: vi.fn().mockResolvedValue(repo)
      })
      const response = await dispatcher.dispatch(
        makeRequest('repo.add', {
          path: `${alias}${sep}packages${sep}..${sep}packages`,
          kind: 'git'
        })
      )
      expect(response).toMatchObject({
        ok: true,
        result: { repo: { id: repo.id, path: repo.path }, selectedPath: selected }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
