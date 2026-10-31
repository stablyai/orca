import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutoverChain, removeWslMoveCutover } from './wsl-move-cutover-journal'
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
  it("plans the distro's first move with the selected projects, then journals it", () => {
    const plan = ready(
      planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'Ubuntu', NO_HOST, {
        repoIds: ['repo-a'],
        folderWorkspaceIds: []
      })
    )
    expect(plan).toMatchObject({ repoIds: ['repo-a'], generation: 1, changed: [], removed: [] })
    expect(plan.supersedesMigrationId).toBeUndefined()

    journalWslMove({
      userDataPath: dir,
      plan,
      manifest: moveFor('move-1', plan),
      destinationName: 'Ubuntu'
    })

    expect(listWslMoveCutoverChain(dir, plan.journalKey).map((entry) => entry.phase)).toEqual([
      'prepared'
    ])
  })

  it('chains a delta move that takes only the new project', () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a'], 1))

    const plan = ready(planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'ubuntu', NO_HOST))
    expect(plan).toMatchObject({
      repoIds: ['repo-b'],
      supersedesMigrationId: 'move-1',
      destinationEnvironmentId: 'wsl:Ubuntu',
      generation: 2
    })
    journalWslMove({
      userDataPath: dir,
      plan,
      manifest: moveFor('move-2', plan),
      destinationName: 'Ubuntu'
    })
    seedWslMoveCutover(dir, {
      ...listWslMoveCutoverChain(dir, plan.journalKey)[1],
      phase: 'retained'
    })

    const chain = listWslMoveCutoverChain(dir, plan.journalKey)
    expect(chain.map((entry) => [entry.migrationId, entry.supersedesMigrationId])).toEqual([
      ['move-1', undefined],
      ['move-2', 'move-1']
    ])
    // A third move finds nothing left to take.
    expect(planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'Ubuntu', NO_HOST)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_nothing_new'
    })
  })

  it('refuses a second move while one of the distro is in flight', () => {
    const rows = state([repo('repo-a'), repo('repo-b')])
    const first = ready(
      planWslMove(dir, rows, 'Ubuntu', NO_HOST, { repoIds: ['repo-a'], folderWorkspaceIds: [] })
    )
    const second = ready(
      planWslMove(dir, rows, 'Ubuntu', NO_HOST, { repoIds: ['repo-b'], folderWorkspaceIds: [] })
    )
    journalWslMove({
      userDataPath: dir,
      plan: first,
      manifest: moveFor('move-1', first),
      destinationName: 'Ubuntu'
    })

    expect(planWslMove(dir, rows, 'Ubuntu', NO_HOST)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_already_in_flight'
    })
    // A plan made before the first journaled loses at the journal's own check.
    expect(() =>
      journalWslMove({
        userDataPath: dir,
        plan: second,
        manifest: moveFor('move-2', second),
        destinationName: 'Ubuntu'
      })
    ).toThrow('wsl_move_already_in_flight')
  })

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

  it('lists, but never takes again, a moved project an older build changed or removed', () => {
    seedWslMoveCutover(
      dir,
      wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-a', 'gone'] })
    )
    const result = planWslMove(
      dir,
      state([repo('repo-a', { displayName: 'renamed' }), repo('repo-b')]),
      'Ubuntu',
      NO_HOST
    )
    expect(ready(result)).toMatchObject({
      repoIds: ['repo-b'],
      changed: [{ kind: 'repo', id: 'repo-a' }],
      removed: [{ kind: 'repo', id: 'gone' }]
    })
  })

  it('ignores SSH rows and other hosts that share a moved id', () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a'], 1))
    const rows = state([
      repo('repo-a'),
      repo('repo-a', { path: '/home/dev/repo-a', executionHostId: 'runtime:wsl-ubuntu' }),
      repo('repo-a', { connectionId: 'ssh-1', displayName: 'remote' })
    ])
    expect(planWslMove(dir, rows, 'Ubuntu', NO_HOST)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_nothing_new'
    })
  })

  it('refuses a manifest that is not the plan', () => {
    const plan = ready(planWslMove(dir, state([repo('repo-a'), repo('repo-b')]), 'Ubuntu', NO_HOST))
    expect(() =>
      journalWslMove({
        userDataPath: dir,
        plan,
        manifest: moveFor('move-1', { ...plan, repoIds: ['repo-a'] }),
        destinationName: 'Ubuntu'
      })
    ).toThrow('wsl_move_manifest_not_planned')
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

  it("lists a project another distro's host owns instead of taking it twice", () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a'], 1))
    const debian = (id: string) => repo(id, { path: `\\\\wsl.localhost\\Debian\\src\\${id}` })
    const result = planWslMove(dir, state([debian('repo-a'), debian('repo-d')]), 'Debian', NO_HOST)
    expect(ready(result)).toMatchObject({
      repoIds: ['repo-d'],
      changed: [{ kind: 'repo', id: 'repo-a' }]
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

  it('lists a moved project whose path an older build took out of the distro as changed', () => {
    seedWslMoveCutover(dir, retainedMove('move-1', ['repo-a', 'repo-m'], 1))
    const rows = state([
      repo('repo-a', { path: 'C:\\src\\repo-a' }),
      // Partly on Windows now: refused by the scope rule, but still here.
      repo('repo-m', { worktreeBasePath: 'C:\\trees' }),
      repo('repo-b')
    ])
    const plan = ready(planWslMove(dir, rows, 'Ubuntu', NO_HOST))
    expect(plan.repoIds).toEqual(['repo-b'])
    expect(plan.removed).toEqual([])
    expect(plan.changed).toEqual([
      { kind: 'repo', id: 'repo-a' },
      { kind: 'repo', id: 'repo-m' }
    ])
    expect(plan.refused).toEqual([{ kind: 'repo', id: 'repo-m', reason: 'mixed-locations' }])
  })

  it('takes only the ticked projects and folder workspaces', () => {
    const folder = {
      id: 'notes',
      projectGroupId: 'group',
      name: 'notes',
      folderPath: `${UNC}\\srv\\notes`,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const plan = ready(
      planWslMove(dir, state([repo('repo-a'), repo('repo-b')], [folder]), 'Ubuntu', NO_HOST, {
        repoIds: ['repo-b'],
        folderWorkspaceIds: ['notes']
      })
    )
    expect([plan.repoIds, plan.folderWorkspaceIds]).toEqual([['repo-b'], ['notes']])
  })
})
