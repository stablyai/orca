import { describe, expect, it } from 'vitest'
import { GitCommandTimeoutError } from '../../../shared/git/commands/git-command-timeout'
import { readDefaultBaseRefViaExec } from '../../../shared/git/refs/git-default-base-ref'
import { resolveWorktreeCreateBase } from './worktree-create-base'

const timedOutLookup = () =>
  readDefaultBaseRefViaExec(async () => {
    throw new GitCommandTimeoutError(15_000)
  })
const isBaseUsable = async (ref: string) => ref === 'custom'

describe('resolveWorktreeCreateBase default-base lookup', () => {
  it('reports a failed lookup instead of resolving as no default base', async () => {
    await expect(
      resolveWorktreeCreateBase({ resolveDefaultBaseRef: timedOutLookup, isBaseUsable })
    ).rejects.toThrow('Could not look up the default base branch')
    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'custom',
        resolveDefaultBaseRef: timedOutLookup,
        isBaseUsable
      })
    ).resolves.toBe('custom')
    await expect(
      resolveWorktreeCreateBase({
        resolveDefaultBaseRef: timedOutLookup,
        isBaseUsable,
        explicitBaseHint: 'pass an explicit --base-branch'
      })
    ).rejects.toThrow('Try again, or pass an explicit --base-branch.')
  })

  it('resolves null when the lookup succeeds but finds no default base', async () => {
    await expect(
      resolveWorktreeCreateBase({
        resolveDefaultBaseRef: () => readDefaultBaseRefViaExec(async () => ({ stdout: '' })),
        isBaseUsable
      })
    ).resolves.toBeNull()
  })
})
