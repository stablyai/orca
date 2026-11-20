import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertLeftoverIsRecordedCheckout } from './worktree-removal-leftover'

let worktreePath: string

beforeEach(async () => {
  worktreePath = await mkdtemp(join(tmpdir(), 'orca-removal-gitdir-'))
})

afterEach(async () => {
  await rm(worktreePath, { recursive: true, force: true })
})

it('refuses a leftover whose .git names a different admin entry than the accepted checkout', async () => {
  await writeFile(join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/other\n')

  await expect(
    assertLeftoverIsRecordedCheckout({ worktreePath, gitdir: '/repo/.git/worktrees/feature' })
  ).rejects.toThrow('A different checkout is now at')
})

it('accepts the leftover of the accepted checkout', async () => {
  await writeFile(join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/feature\n')

  await expect(
    assertLeftoverIsRecordedCheckout({ worktreePath, gitdir: '/repo/.git/worktrees/feature' })
  ).resolves.toBeUndefined()
})
