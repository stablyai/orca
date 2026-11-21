import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  assertCheckoutNotReplaced,
  assertLeftoverIsRecordedCheckout
} from './worktree-removal-leftover'
import { readCheckoutMarkerIdentity } from './worktree-removal-gitdir-identity'

let worktreePath: string

beforeEach(async () => {
  worktreePath = await mkdtemp(join(tmpdir(), 'orca-removal-gitdir-'))
})

afterEach(async () => {
  await rm(worktreePath, { recursive: true, force: true })
})

async function acceptCheckout(adminName: string): Promise<string | undefined> {
  await writeFile(join(worktreePath, '.git'), `gitdir: /repo/.git/worktrees/${adminName}\n`)
  return readCheckoutMarkerIdentity(worktreePath)
}

it('refuses a leftover whose .git names a different admin entry than the accepted checkout', async () => {
  const gitdir = await acceptCheckout('feature')
  await writeFile(join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/other\n')

  await expect(assertLeftoverIsRecordedCheckout({ worktreePath, gitdir })).rejects.toThrow(
    'A different checkout is now at'
  )
})

it('accepts the leftover of the accepted checkout', async () => {
  const gitdir = await acceptCheckout('feature')

  await expect(assertLeftoverIsRecordedCheckout({ worktreePath, gitdir })).resolves.toBeUndefined()
})

it('refuses a registered checkout whose marker changed, but not one whose marker is gone', async () => {
  const gitdir = await acceptCheckout('feature')
  await writeFile(join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/other\n')
  await expect(assertCheckoutNotReplaced({ worktreePath, gitdir })).rejects.toThrow(
    'A different checkout is now at'
  )

  await rm(join(worktreePath, '.git'))
  await expect(assertCheckoutNotReplaced({ worktreePath, gitdir })).resolves.toBeUndefined()
})

it('refuses a leftover whose record predates marker identity', async () => {
  await acceptCheckout('feature')

  await expect(
    assertLeftoverIsRecordedCheckout({ worktreePath, gitdir: undefined })
  ).rejects.toThrow('cannot confirm')
})

it('refuses a registered checkout with a marker when its record predates marker identity', async () => {
  await acceptCheckout('feature')

  await expect(assertCheckoutNotReplaced({ worktreePath, gitdir: undefined })).rejects.toThrow(
    'cannot confirm'
  )
})
