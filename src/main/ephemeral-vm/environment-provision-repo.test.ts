import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { provisionRecipeEnvironment } from './environment-provision'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence/loading-store/store'

function repoAt(path: string): Repo {
  return { id: 'shared-id', path, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
}

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-provision-repo-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

it('provisions against the repo the caller resolved, not another host’s twin with the same id', async () => {
  const resolved: Repo = repoAt(join(userDataPath, 'resolved'))
  const twin: Repo = repoAt(join(userDataPath, 'twin'))
  const getRepo = vi.fn(() => twin)

  // No recipes exist at either path, so the run stops at recipe lookup after choosing its repo.
  const result = await provisionRecipeEnvironment(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only getRepo from the store before it stops at recipe lookup.
    { getRepo } as unknown as Store,
    userDataPath,
    { repoId: 'shared-id', recipeId: 'missing' },
    [],
    { repo: resolved }
  )

  expect(getRepo).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: false, errorCode: 'recipeNotFound' })
})
