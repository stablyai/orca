import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { resolveProjectHostSetupProjection } from '../../../src/shared/project-catalog-canonical-projection'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../src/shared/project-section-grouping'
import type { Repo } from '../../../src/shared/repo-types'
import { resolveServedProjectSectionClaims } from '../../../src/shared/project-section-catalog-claims'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_HEADERS,
  OLD_PROJECT_SECTION_PARITY_SERVED,
  PROJECT_SECTION_PARITY_ROWS,
  PROJECT_SECTION_PARITY_SERVED
} from '../../../src/shared/project-section-parity.test-fixture'
import { buildProjectSectionCatalog } from './project-section-catalog'
import {
  projectSectionsRead,
  readServedProjectSections,
  type ServedProjectSections
} from './project-sections-operations'
import { buildSections, type Worktree } from './workspace-list-sections'

// Counterpart: renderer sidebar/worktree-list-groups-mobile-parity.test.ts uses the same served project fixtures.

function served(): ServedProjectSections | null {
  const verdict = projectSectionsRead.interpret({
    id: 'sections',
    ok: true,
    result: { catalog: PROJECT_SECTION_PARITY_SERVED }
  })
  return verdict.accepted ? verdict.value : null
}

function rows(): Worktree[] {
  const repoById = new Map(PROJECT_SECTION_PARITY_SERVED.repos.map((repo) => [repo.id, repo]))
  return PROJECT_SECTION_PARITY_ROWS.flatMap((row) => {
    const repo = repoById.get(row.repoId)
    return repo
      ? [
          {
            worktreeId: row.id,
            repoId: row.repoId,
            hostId: getRepoExecutionHostId(repo),
            repo: repo.displayName,
            branch: 'feature',
            displayName: row.id,
            path: `${repo.path}-${row.id}`,
            lastActivityAt: row.lastActivityAt,
            liveTerminalCount: 0,
            hasAttachedPty: false,
            unread: false,
            isPinned: false,
            linkedPR: null
          }
        ]
      : []
  })
}

function headers(catalog: ReturnType<typeof buildProjectSectionCatalog>) {
  return buildSections(
    rows(),
    'recent',
    { ...NO_WORKSPACE_ROW_FILTERS },
    '',
    'repo',
    new Set(),
    catalog
  ).map((section) => ({ key: section.key, label: section.title }))
}

describe('Project grouping on the phone', () => {
  it.each(['recent', 'manual'] as const)(
    "renders the desktop sidebar's %s headers from the catalog the desktop serves",
    (projectOrderBy) => {
      expect(rows()).toHaveLength(PROJECT_SECTION_PARITY_ROWS.length)
      expect(headers(buildProjectSectionCatalog(served(), [], null, projectOrderBy))).toEqual(
        PROJECT_SECTION_PARITY_HEADERS[projectOrderBy]
      )
    }
  )

  it.each(['recent', 'manual'] as const)(
    'normalizes an accepted old %s snapshot without losing independent clones or concrete targets',
    (order) => {
      const verdict = projectSectionsRead.interpret({
        id: 'old',
        ok: true,
        result: { catalog: OLD_PROJECT_SECTION_PARITY_SERVED }
      })
      expect(verdict.accepted).toBe(true)
      if (!verdict.accepted || !verdict.value) {
        throw new Error('old catalog refused')
      }
      const canonical = resolveServedProjectSectionClaims(verdict.value)
      expect(resolveServedProjectSectionClaims(canonical)).toBe(canonical)
      const catalog = buildProjectSectionCatalog(verdict.value, [], null, order)
      expect(headers(catalog)).toEqual(PROJECT_SECTION_PARITY_HEADERS[order])
      expect(catalog.repos.map((repo) => repo.id)).toEqual(
        PROJECT_SECTION_PARITY_SERVED.repos.map((repo) => repo.id)
      )
      expect(
        canonical.setups.map(({ repoId, hostId, path }) => ({ repoId, hostId, path }))
      ).toEqual(verdict.value.setups.map(({ repoId, hostId, path }) => ({ repoId, hostId, path })))
      expect(
        canonical.setups
          .filter((setup) => setup.projectId.startsWith('repo:'))
          .map((setup) => setup.repoId)
      ).toEqual(['local-assets', 'local-workspace', 'm4-orca-two'])
    }
  )

  it("groups by repo from an older desktop's own repos when it serves no catalog", () => {
    const desktopRepos = PROJECT_SECTION_PARITY_SERVED.repos.filter(
      (repo) => repo.executionHostId === 'local'
    )

    expect(headers(buildProjectSectionCatalog(null, desktopRepos, null, 'manual'))).toEqual([
      { key: 'repo:m4-orca-two', label: 'orca' },
      { key: 'repo:win-orca', label: 'orca' },
      { key: 'repo:local-workspace', label: 'orca/orca' },
      { key: 'repo:local-stably', label: 'stably/orca' },
      { key: 'repo:m4-orca', label: 'orca' },
      { key: 'repo:local-assets', label: 'design-assets' }
    ])
  })

  it('drops a served setup whose host id this build cannot read, keeping the rest', () => {
    const verdict = projectSectionsRead.interpret({
      id: 'sections',
      ok: true,
      result: {
        catalog: {
          ...PROJECT_SECTION_PARITY_SERVED,
          setups: [
            { ...PROJECT_SECTION_PARITY_SERVED.setups[0], hostId: 'nonsense' },
            ...PROJECT_SECTION_PARITY_SERVED.setups.slice(1)
          ]
        }
      }
    })

    expect(verdict.accepted && verdict.value?.setups).toHaveLength(
      PROJECT_SECTION_PARITY_SERVED.setups.length - 1
    )
  })
})

describe('readServedProjectSections', () => {
  it('reads a served catalog, and a desktop with no published window as none', () => {
    expect(
      readServedProjectSections({
        id: 'sections',
        ok: true,
        result: { catalog: PROJECT_SECTION_PARITY_SERVED }
      })
    ).toMatchObject({ kind: 'answered', value: { repos: expect.any(Array) } })
    expect(
      readServedProjectSections({ id: 'sections', ok: true, result: { catalog: null } })
    ).toEqual({ kind: 'answered', value: null })
  })

  it.each(['forbidden', 'method_not_found'])(
    'reads an older desktop that answers %s as serving none',
    (code) => {
      expect(
        readServedProjectSections({ id: 'sections', ok: false, error: { code, message: code } })
      ).toEqual({ kind: 'answered', value: null })
    }
  )

  it('keeps the last catalog after a timeout or a dropped reply', () => {
    expect(
      readServedProjectSections({
        id: 'sections',
        ok: false,
        error: { code: 'timeout', message: 'timed out' }
      })
    ).toEqual({ kind: 'kept' })
    expect(readServedProjectSections(null)).toEqual({ kind: 'kept' })
  })
})

it('keeps published desktop affiliation through phone parsing when a setup has no registered owner', () => {
  const repo: Repo = {
    id: 'a',
    path: '/a',
    displayName: 'A',
    badgeColor: '',
    addedAt: 1,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/app.git'
    }
  }
  const derived = projectHostSetupProjectionFromRepos([repo])
  const firstSetup = derived.setups[0]
  if (!firstSetup) {
    throw new Error('no derived setup')
  }
  const orphan = {
    ...firstSetup,
    id: 'z',
    repoId: 'z',
    path: '/z',
    displayName: 'Z',
    createdAt: 0,
    updatedAt: 0
  }
  const projection = resolveProjectHostSetupProjection([repo], derived.projects, [
    ...derived.setups,
    orphan
  ])
  const published = buildMobileProjectSectionCatalog([repo], projection, 'manual')
  const repoMap = new Map([[repo.id, repo]])
  const desktop = getProjectGroupingForRepo(
    'a',
    repoMap,
    buildProjectGroupingIndex({
      projects: published.projects,
      projectHostSetups: published.setups
    })
  )
  expect(desktop.key).toBe(`project:${derived.projects[0].id}`)
  for (const extraRepos of [[], [{ id: 'z', displayName: 'Z', path: 42, addedAt: 0 }]]) {
    const verdict = projectSectionsRead.interpret({
      id: 'sections',
      ok: true,
      result: { catalog: { ...published, repos: [...published.repos, ...extraRepos] } }
    })
    if (!verdict.accepted || !verdict.value) {
      throw new Error('catalog refused')
    }
    expect(verdict.value.repos.map((row) => row.id)).toEqual(['a'])
    expect(verdict.value.setups.map((row) => row.repoId)).toEqual(['a', 'z'])
    const phone = buildProjectSectionCatalog(verdict.value, [], null, 'manual')
    if (!phone.grouping) {
      throw new Error('No served project grouping')
    }
    expect(
      getProjectGroupingForRepo('a', repoMap, buildProjectGroupingIndex(phone.grouping)).key
    ).toBe(desktop.key)
    expect(
      phone.grouping?.projectHostSetups?.map(({ repoId, hostId, path }) => ({
        repoId,
        hostId,
        path
      }))
    ).toEqual(verdict.value.setups.map(({ repoId, hostId, path }) => ({ repoId, hostId, path })))
  }
  const old = projectSectionsRead.interpret({
    id: 'old',
    ok: true,
    result: {
      catalog: {
        ...published,
        repos: [...published.repos, { id: 'z', displayName: 'Z', path: '/z' }]
      }
    }
  })
  if (!old.accepted || !old.value) {
    throw new Error('old catalog refused')
  }
  const phone = buildProjectSectionCatalog(old.value, [], null, 'manual')
  if (!phone.grouping) {
    throw new Error('No served project grouping')
  }
  expect(
    getProjectGroupingForRepo('a', repoMap, buildProjectGroupingIndex(phone.grouping)).key
  ).toBe('project:repo:a')
})
