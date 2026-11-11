import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { removeWslMoveCutover } from './wsl-move-cutover-journal'
import { journalWslMove, planWslMove, type WslMovePlan } from './wsl-move-delta-plan'

const UNC = '\\\\wsl.localhost\\Ubuntu'
const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path: `${UNC}\\home\\dev\\${id}`,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0,
  ...extra
})

const NO_HOST = { repoIds: [], folderWorkspaceIds: [], highestGeneration: 0 }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsl-move-delta-plan-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function state(repos: Repo[], folderWorkspaces: FolderWorkspace[] = []) {
  return { repos, folderWorkspaces, projectGroups: [] }
}

/** The fixture's manifest for a scope and generation, re-signed. */
function moveFor(migrationId: string, plan: Pick<WslMovePlan, 'repoIds' | 'generation'>) {
  const base = wslMoveCutoverFixture(migrationId, 'prepared', {}, { repoIds: plan.repoIds })
  const { manifestSha256: _unsigned, ...unsigned } = base.manifest
  const resigned = {
    ...unsigned,
    source: { ...unsigned.source, generation: plan.generation }
  }
  return { ...resigned, manifestSha256: computeOrcadMigrationManifestSha256(resigned) }
}

/** A finished move of `repoIds`, as a journal record. */
function retainedMove(
  migrationId: string,
  repoIds: string[],
  generation: number,
  supersedesMigrationId?: string
) {
  const manifest = moveFor(migrationId, { repoIds, generation })
  return {
    ...wslMoveCutoverFixture(
      migrationId,
      'retained',
      supersedesMigrationId ? { supersedesMigrationId } : {}
    ),
    manifest,
    manifestSha256: manifest.manifestSha256
  }
}

function ready(result: ReturnType<typeof planWslMove>): WslMovePlan {
  if (result.outcome !== 'ready') {
    throw new Error(result.code)
  }
  return result.plan
}

describe('planWslMove', () => {
  it('refuses a delta planned against a head that has since moved on', () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a'], 1))
    const stale = ready(
      planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'Ubuntu', NO_HOST)
    )
    seedWslMoveCutover(dir, retainedMove('move-2', ['repo-c'], 2, 'move-1'))

    expect(() =>
      journalWslMove({
        userDataPath: dir,
        plan: stale,
        manifest: moveFor('move-3', stale),
        destinationName: 'Ubuntu'
      })
    ).toThrow('wsl_move_must_extend_its_chain')
  })

  it('never takes again what the host still holds after its move was dropped', () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a'], 1))
    seedWslMoveCutover(dir, retainedMove('move-2', ['repo-b'], 2, 'move-1'))
    // What "Use on this computer again" does: the host keeps repo-b and its generation.
    removeWslMoveCutover(dir, 'move-2')

    const plan = ready(
      planWslMove(dir, state([repo('repo-a'), repo('repo-b'), repo('repo-c')]), 'Ubuntu', {
        repoIds: ['repo-a', 'repo-b'],
        folderWorkspaceIds: [],
        highestGeneration: 2
      })
    )
    expect(plan).toMatchObject({
      repoIds: ['repo-c'],
      heldByHost: [{ kind: 'repo', id: 'repo-b' }],
      supersedesMigrationId: 'move-1',
      generation: 3
    })
  })

  it('refuses a manifest whose scope doubles an id', () => {
    const plan = ready(planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'Ubuntu', NO_HOST))
    expect(() =>
      journalWslMove({
        userDataPath: dir,
        plan: { ...plan, repoIds: ['repo-a', 'repo-a'] },
        manifest: moveFor('move-1', plan),
        destinationName: 'Ubuntu'
      })
    ).toThrow('wsl_move_manifest_not_planned')
  })
})
