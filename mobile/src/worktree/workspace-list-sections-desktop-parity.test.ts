import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_HEADERS,
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
