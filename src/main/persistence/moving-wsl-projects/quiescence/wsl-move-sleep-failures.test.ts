import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceSleepOutcome } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import { WORKSPACE_SELECTOR_NOT_FOUND } from '../../../runtime/workspaces/catalog/workspace-selector-candidates'
import { wslMoveSleepFailures } from './wsl-move-sleep-failures'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsl-move-sleep-failures-'))
  mkdirSync(join(root, 'present'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const store = () => ({
  getRepos: () => [{ id: 'repo-1', path: root, displayName: 'repo', badgeColor: '', addedAt: 0 }]
})
const id = (folder: string) => `repo-1::${join(root, folder)}`
const outcome = (worktreeId: string, failure?: string): WorkspaceSleepOutcome => ({
  worktreeId,
  ...(failure ? { failure } : {}),
  chatFailed: false,
  receipts: []
})

describe('wslMoveSleepFailures', () => {
  // #44255: saved rows of worktrees deleted outside Orca refused every move.
  it('counts a worktree Git does not list and whose folder is gone as paused', async () => {
    const outcomes = [
      outcome(id('present')),
      outcome(id('deleted-outside-orca'), WORKSPACE_SELECTOR_NOT_FOUND),
      outcome(id('.worktrees/feat/old'), WORKSPACE_SELECTOR_NOT_FOUND)
    ]
    await expect(
      wslMoveSleepFailures(outcomes, { store: store(), hasLiveTerminal: () => false })
    ).resolves.toEqual([])
  })

  it('keeps refusing a not-found worktree whose folder is there, such as a listing gap', async () => {
    const outcomes = [outcome(id('present'), WORKSPACE_SELECTOR_NOT_FOUND)]
    await expect(
      wslMoveSleepFailures(outcomes, { store: store(), hasLiveTerminal: () => false })
    ).resolves.toEqual([id('present')])
  })

  it('keeps refusing a removed worktree while a terminal of it runs', async () => {
    const outcomes = [outcome(id('deleted-outside-orca'), WORKSPACE_SELECTOR_NOT_FOUND)]
    await expect(
      wslMoveSleepFailures(outcomes, { store: store(), hasLiveTerminal: () => true })
    ).resolves.toEqual([id('deleted-outside-orca')])
  })
})
