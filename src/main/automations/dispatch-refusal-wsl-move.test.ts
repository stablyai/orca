import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  NO_DISPATCH_HOST,
  WSL_MOVE_IN_PROGRESS,
  WSL_MOVE_OWNED_BY_HOST,
  describeScheduledRefusal
} from './dispatch-refusal'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/ws/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...overrides }
}

const refusalFor = (target: Repo, canDispatch = true) =>
  describeScheduledRefusal({ target: { ok: true, cwd: target.path, repo: target }, canDispatch })
    ?.error ?? null

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-automation-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('describeScheduledRefusal under a WSL move', () => {
  it('refuses a run in the moving project with one fixed sentence', () => {
    expect(refusalFor(repo('repo-1'))).toBe(WSL_MOVE_IN_PROGRESS)
    expect(refusalFor(repo('repo-1'), false)).toBe(WSL_MOVE_IN_PROGRESS)
    expect(WSL_MOVE_IN_PROGRESS).toBe(
      "This automation's project is moving to its WSL host, so Orca skipped this run. Runs resume when the move finishes."
    )
  })

  it('says the WSL host runs it once the host owns the project', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    expect(refusalFor(repo('repo-1'))).toBe(WSL_MOVE_OWNED_BY_HOST)
    expect(WSL_MOVE_OWNED_BY_HOST).toBe(
      "This automation's project now runs on its WSL host, which runs this automation there. Orca no longer runs this local copy."
    )
  })

  it('runs a project the move is not taking', () => {
    expect(refusalFor(repo('repo-2'))).toBeNull()
    expect(refusalFor(repo('repo-2'), false)).toBe(NO_DISPATCH_HOST)
  })

  it('runs the same repo id on another host', () => {
    expect(
      refusalFor(repo('repo-1', { connectionId: 'target-1', executionHostId: 'ssh:target-1' }))
    ).toBeNull()
  })
})
