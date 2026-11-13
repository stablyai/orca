import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { wslMoveCutoverFixture as cutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { NO_DISPATCH_HOST, describeScheduledRefusal } from './dispatch-refusal'

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
