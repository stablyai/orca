import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorktreeCheckoutIdentity } from '../../../shared/worktree/removal/worktree-checkout-identity'
import { WorktreeRemovalExpectation } from './worktree-removal-expectation'

let dir: string | undefined
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function resumed(root: string): WorktreeRemovalExpectation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the expectation reads only this host's worktree meta.
  const store = {
    getWorktreeMetaForHost: () => ({ instanceId: 'instance-1', isPinned: false })
  } as unknown as RuntimeStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded proof the live checkout cannot match.
  const checkoutIdentity = {
    instanceId: 'instance-1',
    root,
    rootKey: 'recorded',
    markerKey: 'recorded',
    gitDir: join(root, '.git-admin'),
    adminKey: 'recorded',
    nonce: '00000000-0000-0000-0000-000000000000'
  } as WorktreeCheckoutIdentity
  return new WorktreeRemovalExpectation(store, {
    worktreeId: `repo::${root}`,
    instanceId: 'instance-1',
    checkoutIdentity
  })
}

it('reports a reviewed checkout Git already deleted before a restart as gone', async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-resume-'))
  const gone = join(dir, 'removed-checkout')
  expect(await resumed(gone).resumeCheckout(gone)).toBe('gone')
})

it('still refuses a checkout that exists but is not the reviewed one', async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-resume-'))
  await expect(resumed(dir).resumeCheckout(dir)).rejects.toMatchObject({
    code: 'ERR_ORCA_WORKTREE_CHANGED'
  })
})
