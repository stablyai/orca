import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { annotatePrunableWorktreesByExistence } from './git-handler-worktree-list'

const tempRoots: string[] = []

async function createTempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-relay-prunable-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('annotatePrunableWorktreesByExistence', () => {
  it('marks linked worktrees with missing directories as prunable', async () => {
    const liveDir = await createTempDir()
    const missingDir = path.join(liveDir, 'deleted-worktree')

    const annotated = await annotatePrunableWorktreesByExistence([
      { path: liveDir, isMainWorktree: true },
      { path: path.join(liveDir, 'also-missing-main'), isMainWorktree: true },
      { path: liveDir, isMainWorktree: false },
      { path: missingDir, isMainWorktree: false }
    ])

    expect(annotated[0]?.prunable).toBeUndefined()
    // Git never marks the main worktree prunable; repo-level handling owns it.
    expect(annotated[1]?.prunable).toBeUndefined()
    expect(annotated[2]?.prunable).toBeUndefined()
    expect(annotated[3]).toMatchObject({ path: missingDir, prunable: true })
  })

  it('shields locked registrations, mirroring git prunable semantics', async () => {
    const liveDir = await createTempDir()
    const missingDir = path.join(liveDir, 'deleted-locked-worktree')

    const annotated = await annotatePrunableWorktreesByExistence([
      { path: liveDir, isMainWorktree: true },
      { path: missingDir, isMainWorktree: false, locked: true, lockReason: 'agent session' }
    ])

    expect(annotated[1]?.prunable).toBeUndefined()
  })
})
