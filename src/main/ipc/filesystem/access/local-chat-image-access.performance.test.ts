import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../runtime/construction/test-context/runtime-store-partial-fixture'
import { registerWorktreeRootsForRepo } from '../../worktrees/removal/registered-worktree-roots-cache'
import { resolveLocalFileRequestPath } from './local-file-access-resolution'

it.each([750, 7500])(
  'authorizes local image paths without scanning %i registered roots',
  async (count) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'orca-image-access-'))
    try {
      const repo = storeRepo({ id: 'repo', path: root })
      const getRepos = vi.fn(() => [repo])
      const store = partialRuntimeStore({ getRepos })
      registerWorktreeRootsForRepo(
        store,
        repo,
        Array.from({ length: count }, (_, index) => join(root, `worktree-${index}`))
      )
      const source = join(root, 'shot.png')
      await writeFile(source, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      getRepos.mockClear()
      await expect(
        resolveLocalFileRequestPath(source, { kind: 'chat-image' }, store)
      ).resolves.toBe(source)
      expect(getRepos).toHaveBeenCalledTimes(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
