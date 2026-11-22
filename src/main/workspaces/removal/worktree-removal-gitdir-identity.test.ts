import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  assertCheckoutNotReplaced,
  assertLeftoverIsRecordedCheckout
} from './worktree-removal-leftover'
import {
  captureAcceptedCheckoutGuard,
  proveOrphanedCheckoutGuard,
  readCheckoutMarkerIdentity
} from './worktree-removal-gitdir-identity'

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

it('refuses a standalone repository whose .git is a directory instead of treating it as stripped', async () => {
  const gitdir = await acceptCheckout('feature')
  await rm(join(worktreePath, '.git'))
  await mkdir(join(worktreePath, '.git'))

  await expect(assertCheckoutNotReplaced({ worktreePath, gitdir })).rejects.toThrow(
    'A different checkout is now at'
  )
})

it('fails closed at acceptance when .git is an unrecognized file or directory instead of disabling the guard', async () => {
  await writeFile(join(worktreePath, '.git'), '')
  await expect(captureAcceptedCheckoutGuard(worktreePath)).rejects.toThrow(
    'cannot confirm the checkout at'
  )

  await rm(join(worktreePath, '.git'))
  await mkdir(join(worktreePath, '.git'))
  await expect(captureAcceptedCheckoutGuard(worktreePath)).rejects.toThrow(
    'cannot confirm the checkout at'
  )
})

it('binds orphan ownership proof to the initial marker and forbids new markers if it vanishes mid-proof', async () => {
  await acceptCheckout('feature')

  await expect(
    proveOrphanedCheckoutGuard(worktreePath, {}, async () => {
      await writeFile(join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/replaced\n')
      return true
    })
  ).rejects.toThrow('A different checkout is now at')

  await acceptCheckout('feature-2')
  const vanishedGuard = await proveOrphanedCheckoutGuard(worktreePath, {}, async () => {
    await rm(join(worktreePath, '.git'))
    return true
  })
  expect(vanishedGuard).toMatchObject({ markerLast: true, forbidAnyMarker: true })
  expect(vanishedGuard?.expectedRoot).toMatch(/^\d+:\d+$/)

  const pinned = await acceptCheckout('accepted')
  await writeFile(
    join(worktreePath, '.git'),
    'gitdir: /repo/.git/worktrees/restored-before-proof\n'
  )
  await expect(
    proveOrphanedCheckoutGuard(worktreePath, {}, async () => true, { expectedMarker: pinned })
  ).rejects.toThrow('A different checkout is now at')
})
