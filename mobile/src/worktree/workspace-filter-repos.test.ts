import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../src/shared/endpoint-catalog-adoption'
import { buildProjectGroupingIndex } from '../../../src/shared/project-section-grouping'
import {
  projectFilterSelection,
  editProjectFilter
} from '../../../src/shared/project-repo-filter-selection'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { ProjectSectionCatalogSchema } from '../../../src/shared/project-section-catalog-schema'
import { buildProjectSectionCatalog } from './project-section-catalog'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
vi.mock('../i18n/mobile-i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  getMobileLocale: () => 'en'
}))
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it, vi } from 'vitest'
import {
  workspaceProjectFilterSelection,
  buildFilterRepos,
  selectedWorkspaceProjectKeys,
  toggleProjectFilter
} from './workspace-filter-repos'
import { filterWorktrees, type Worktree } from './workspace-list-sections'

function row(worktreeId: string, repoId: string, hostId: Worktree['hostId']): Worktree {
  return {
    worktreeId,
    repoId,
    hostId,
    repo: 'orca',
    branch: 'feature',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('the repo filter', () => {
  it('uses served grouping membership for checked state and preserves partial/offline choices on group edits', () => {
    const repos = ['a', 'b'].map((id) => ({
      id,
      displayName: 'app',
      path: `/repos/${id}`,
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' }
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    const rows = buildFilterRepos(repos, [], {
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    expect(rows).toHaveLength(1)
    expect(selectedWorkspaceProjectKeys(rows, ['a', 'offline']).size).toBe(0)
    const next = toggleProjectFilter(rows[0], ['a', 'offline'])
    expect(new Set(next)).toEqual(new Set(['a', 'b', 'offline']))
    expect(selectedWorkspaceProjectKeys(rows, next)).toEqual(new Set([rows[0].key]))
    expect(toggleProjectFilter(rows[0], next)).toEqual(['offline'])
  })

  it("lists each host's same-named repo separately, by id, as the desktop's filter does", () => {
    const repos = buildFilterRepos(
      [
        { id: 'local-orca', displayName: 'orca', path: '/Users/me/orca', badgeColor: '#111111' },
        {
          id: 'm4-orca',
          displayName: 'orca',
          path: '/Users/m4air/orca/orca',
          executionHostId: 'runtime:m4air'
        },
        { id: 'assets', displayName: 'design-assets', path: '/Users/me/design-assets' },
        {
          id: 'local-orca',
          displayName: 'orca',
          path: '/srv/orca',
          executionHostId: 'runtime:other'
        }
      ],
      []
    )

    expect(repos.map(({ key, id, name }) => ({ key, id, name }))).toEqual([
      { key: 'local|local-orca', id: 'local-orca', name: 'orca' },
      { key: 'runtime:m4air|m4-orca', id: 'm4-orca', name: 'orca' },
      { key: 'local|assets', id: 'assets', name: 'design-assets' },
      { key: 'runtime:other|local-orca', id: 'local-orca', name: 'orca' }
    ])
    expect(repos[0]?.color).toBe('#111111')
  })

  it('lists the repos the rows name until a catalog answers, still one per repo id', () => {
    const repos = buildFilterRepos(
      [],
      [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]
    )

    expect(repos.map((repo) => repo.id)).toEqual(['local-orca', 'm4-orca'])
  })

  it('filters by the picked repo id, leaving the same-named repo on another host out', () => {
    const rows = [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]

    expect(
      filterWorktrees(rows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['m4-orca'] }, '').map(
        (w) => w.worktreeId
      )
    ).toEqual(['b'])
  })
})

it('uses qualified tokens and durable offline scope in the catalog-less phone adapter', () => {
  const repos = buildFilterRepos(
    [
      { id: 'same', path: '/a', displayName: 'App' },
      { id: 'same', path: '/b', displayName: 'App', executionHostId: 'runtime:server' }
    ],
    []
  )
  const saved = ['runtime:server\0same', 'offline']
  expect(workspaceProjectFilterSelection(repos, saved)).toMatchObject({
    active: true,
    badgeCount: 1,
    matchingKeys: ['runtime:server|same'],
    unresolved: ['offline']
  })
  expect(
    filterWorktrees(
      [row('local', 'same', 'local'), row('remote', 'same', 'runtime:server')],
      { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: saved },
      ''
    ).map((row) => row.worktreeId)
  ).toEqual(['remote'])
  expect(toggleProjectFilter(repos[1], saved, repos)).toEqual(['offline'])
  expect(workspaceProjectFilterSelection([], ['offline']).badgeCount).toBe(1)
})

it('keeps legacy raw checked state and editing distinct from exact support on the same fallback options', () => {
  const repos = buildFilterRepos(
    [
      { id: 'same', path: '/a', displayName: 'App' },
      { id: 'same', path: '/b', displayName: 'App', executionHostId: 'runtime:server' }
    ],
    []
  )
  const saved = ['runtime:server\0same', 'offline']
  expect(workspaceProjectFilterSelection(repos, saved, 'legacy')).toMatchObject({
    matchingKeys: [],
    unresolved: saved
  })
  expect(toggleProjectFilter(repos[1], saved, repos, 'legacy')).toEqual([...saved, 'same'])
  expect(workspaceProjectFilterSelection(repos, ['same'], 'legacy').fullKeys).toEqual([
    'local|same',
    'runtime:server|same'
  ])
  expect(toggleProjectFilter(repos[1], ['same', 'offline'], repos, 'legacy')).toEqual(['offline'])
})

it.each([100, 1000])(
  'measures the real catalog-less exact filter preparation and edit at %s members with unrelated growth',
  (n) => {
    for (const unrelated of [0, 1000]) {
      const catalog = Array.from({ length: n + unrelated }, (_, i) => ({
        id: `repo-${i}`,
        path: `/repo-${i}`,
        displayName: `Repo ${i}`,
        badgeColor: ''
      }))
      const repos = buildFilterRepos(catalog, [])
      const selected = [...catalog.slice(0, n).map((entry) => entry.id), 'offline']
      const originalGet = Map.prototype.get
      let reads = 0
      let visits = 0
      const originalIterator = Map.prototype[Symbol.iterator]
      const iterationProbe = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
        this: Map<unknown, unknown>
      ) {
        const iterator = originalIterator.call(this)
        const next = iterator.next.bind(iterator)
        iterator.next = (...args: Parameters<typeof iterator.next>) => {
          const result = next(...args)
          if (!result.done) {
            visits++
          }
          return result
        }
        return iterator
      })
      const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown
      ) {
        reads++
        return originalGet.call(this, key)
      })
      try {
        const selection = workspaceProjectFilterSelection(repos, selected, 'exact')
        const cold = reads
        const coldVisits = visits
        expect(selection.fullKeys).toHaveLength(n)
        expect(selection.unresolved).toEqual(['offline'])
        expect(cold).toBeGreaterThan(n + unrelated)
        expect(cold).toBeLessThan(30 * (n + unrelated + selected.length))
        reads = 0
        visits = 0
        expect(workspaceProjectFilterSelection(repos, selected, 'exact')).toBe(selection)
        const warm = reads
        expect(warm).toBe(0)
        expect(visits).toBe(0)
        reads = 0
        const edited = toggleProjectFilter(repos[0], selected, repos, 'exact')
        const edit = reads
        const editVisits = visits
        expect(edited).not.toContain('repo-0')
        expect(edited).toContain('offline')
        expect(edited).toHaveLength(n)
        expect(edit).toBeGreaterThan(0)
        expect(editVisits).toBe(n + unrelated)
        expect(edit).toBeLessThan(10 * (n + unrelated + selected.length))
        process.stdout.write(
          `Q3708 mobile filter operations ${JSON.stringify({ n, unrelated, cold, coldVisits, warm, edit, editVisits, selected: selection.fullKeys.length, edited: edited.length })}\n`
        )
      } finally {
        probe.mockRestore()
        iterationProbe.mockRestore()
      }
    }
  }
)

function nestedEndpointCatalog() {
  const target = { kind: 'environment', environmentId: 'E' } as const
  const authored = [
    { id: 'r', connectionId: 'x', executionHostId: 'ssh:x' as const, path: '/srv/r' },
    { id: 'r', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/r' },
    { id: 'q', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/q' }
  ].map((repo) => ({
    ...repo,
    displayName: repo.path,
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }))
  const original = projectHostSetupProjectionFromRepos(authored)
  return {
    repos: authored.map((repo) => adoptEndpointRepo(target, repo)),
    projection: adoptEndpointProjectCatalog(target, original.projects, original.setups)
  }
}

it('offers the normally published nested containing groups and authors the same physical identity as phone rows', () => {
  const { repos, projection } = nestedEndpointCatalog()
  const model = {
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: { projectGroupingMode: 'host' as const }
  }
  const index = buildProjectGroupingIndex(model)
  const hx = index.groups.find((group) => group.registrations.includes(projection.setups[0]))!
  const hy = index.groups.find((group) => group.registrations.includes(projection.setups[1]))!
  expect(hx).not.toBe(hy)
  const published = buildMobileProjectSectionCatalog(
    repos,
    projection,
    'manual',
    [],
    model.settings,
    index
  )
  expect(published.setups.map((setup) => setup.groupKey)).toEqual([hx.key, hy.key, hy.key])
  const served = ProjectSectionCatalogSchema.parse(published)
  const catalog = buildProjectSectionCatalog(served, repos, null, null)
  const options = buildFilterRepos(catalog.repos, [], catalog.grouping)
  expect(options.map((option) => option.key)).toEqual([hx.key, hy.key])
  const x = options.find((option) => option.key === hx.key)!
  const next = toggleProjectFilter(x, ['offline'], options)
  expect(next).toEqual(['offline', 'ssh:x\0r'])
  const rows = [row('wx', 'r', 'ssh:x'), row('wy', 'r', 'ssh:y'), row('wq', 'q', 'ssh:y')]
  const shown = (ids: string[]) =>
    filterWorktrees(rows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ids }, '').map(
      (item) => item.worktreeId
    )
  expect(shown(['offline', 'r'])).toEqual(['wx', 'wy'])
  expect(shown(next)).toEqual(['wx'])
  const lateRows = [...rows, row('wz', 'r', 'ssh:z')]
  expect(
    filterWorktrees(lateRows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['r'] }, '').map(
      (item) => item.worktreeId
    )
  ).toEqual(['wx', 'wy', 'wz'])
  expect(
    filterWorktrees(lateRows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: next }, '').map(
      (item) => item.worktreeId
    )
  ).toEqual(['wx'])
  expect(next).toEqual(['offline', 'ssh:x\0r'])
  expect(shown(['runtime:E\0r'])).toEqual([])
  expect(workspaceProjectFilterSelection(options, next)).toMatchObject({
    fullKeys: [hx.key],
    partialKeys: [],
    unresolved: ['offline'],
    badgeCount: 1
  })
  expect(workspaceProjectFilterSelection(options, ['runtime:E\0r'])).toMatchObject({
    fullKeys: [],
    unresolved: ['runtime:E\0r'],
    badgeCount: 1
  })
  expect(toggleProjectFilter(x, ['r', 'opaque\0offline'], options)).toEqual([
    'opaque\0offline',
    'ssh:y\0r'
  ])
  const repository = buildProjectGroupingIndex({
    ...model,
    settings: { projectGroupingMode: 'repository' }
  })
  expect(projectFilterSelection(repository, next).partialKeys).toEqual([repository.groups[0].key])
  expect(
    editProjectFilter(repository, next, { kind: 'complete', keys: [repository.groups[0].key] })
  ).toEqual(['offline', 'r', 'q'])
  expect(editProjectFilter(index, next, { kind: 'clear' })).toEqual([])
  for (const mode of ['repository', 'host', 'folder'] as const) {
    const changed = buildProjectGroupingIndex({ ...model, settings: { projectGroupingMode: mode } })
    projectFilterSelection(changed, next)
    expect(shown(next)).toEqual(['wx'])
    expect(next).toEqual(['offline', 'ssh:x\0r'])
  }
  const absent = buildFilterRepos([], [])
  expect(workspaceProjectFilterSelection(absent, next)).toMatchObject({
    active: true,
    unresolved: next,
    badgeCount: 1
  })
  expect(workspaceProjectFilterSelection(options, next).full.has(hx.key)).toBe(true)
})

it.each([100, 1000])(
  'measures complete original nested membership, normal publication and real matcher rows at N=%i',
  (n) => {
    for (const w of [2, n]) {
      for (const q of [1, 2, n]) {
        for (const unrelated of [0, 100]) {
          const authored = Array.from({ length: n + unrelated }, (_, i) => ({
            id: i < w ? 'r' : i < n ? `own-${i}` : `other-${i}`,
            connectionId: `h${i}`,
            executionHostId: `ssh:h${i}` as const,
            displayName: `Repo ${i}`,
            path: `/srv/${i}`,
            badgeColor: '',
            addedAt: 0,
            upstream: { owner: 'org', repo: i < q ? 'target' : `app-${i}` }
          }))
          const target = { kind: 'environment', environmentId: 'E' } as const
          const original = projectHostSetupProjectionFromRepos(authored)
          const adopted = adoptEndpointProjectCatalog(target, original.projects, original.setups)
          let hostReads = 0
          let pathReads = 0
          let pathReadChars = 0
          const setups = adopted.setups.map((setup) => ({
            ...setup,
            get executionHostId() {
              hostReads++
              return setup.executionHostId
            },
            get path() {
              pathReads++
              pathReadChars += setup.path.length
              return setup.path
            }
          }))
          const projection = { projects: adopted.projects, setups }
          const model = { projects: projection.projects, projectHostSetups: setups }
          const index = buildProjectGroupingIndex(model)
          const groupingReads = hostReads
          const groupingPathReads = pathReads
          const groupingPathChars = pathReadChars
          expect(groupingPathReads).toBeGreaterThanOrEqual(n + unrelated)
          expect(groupingReads).toBeGreaterThanOrEqual(n + unrelated)
          let visits = 0
          for (const group of index.groups) {
            const iterator = group.registrations[Symbol.iterator].bind(group.registrations)
            group.registrations[Symbol.iterator] = function* () {
              for (const setup of { [Symbol.iterator]: iterator }) {
                visits++
                yield setup
              }
            }
          }
          hostReads = 0
          pathReads = 0
          const published = buildMobileProjectSectionCatalog(
            authored.map((repo) => adoptEndpointRepo(target, repo)),
            projection,
            'manual',
            [],
            undefined,
            index
          )
          const publicationVisits = visits
          const publicationHostReads = hostReads
          const publicationPathReads = pathReads
          expect(publicationPathReads).toBe(n + unrelated)
          expect(publicationVisits).toBe(n + unrelated)
          expect(published.setups.every((setup) => Boolean(setup.groupKey))).toBe(true)
          const group = index.groups.find((candidate) =>
            candidate.registrations.includes(setups[0])
          )!
          for (const f of [1, 100]) {
            const previous = Array.from({ length: f }, (_, i) => `offline-${i}`)
            let editMatcherBuilds = 0
            let editTokenVisits = 0
            const previousIterator = previous[Symbol.iterator].bind(previous)
            previous[Symbol.iterator] = function* () {
              editMatcherBuilds++
              for (const id of { [Symbol.iterator]: previousIterator }) {
                editTokenVisits++
                yield id
              }
            }
            visits = 0
            hostReads = 0
            let effectiveAddressVisits = 0
            const mapIterator = Map.prototype[Symbol.iterator]
            const addressProbe = vi
              .spyOn(Map.prototype, Symbol.iterator)
              .mockImplementation(function (this: Map<unknown, unknown>) {
                const iterator = mapIterator.call(this)
                const next = iterator.next.bind(iterator)
                iterator.next = (...args: Parameters<typeof iterator.next>) => {
                  const result = next(...args)
                  if (!result.done) {
                    const [key, value] = result.value
                    if (
                      typeof key === 'string' &&
                      key.includes('\0') &&
                      value &&
                      typeof value === 'object' &&
                      'repoId' in value &&
                      'hostId' in value
                    ) {
                      effectiveAddressVisits++
                    }
                  }
                  return result
                }
                return iterator
              })
            const next = (() => {
              try {
                return editProjectFilter(index, previous, { kind: 'complete', keys: [group.key] })
              } finally {
                addressProbe.mockRestore()
              }
            })()
            expect(effectiveAddressVisits).toBe(n + unrelated)
            const editVisits = visits
            const editHostReads = hostReads
            const editBuildCount = editMatcherBuilds
            const editInputVisits = editTokenVisits
            expect(editMatcherBuilds).toBe(1)
            expect(editTokenVisits).toBe(f)
            expect(editVisits).toBe(n + unrelated + q)
            expect(editHostReads).toBe(editVisits)
            expect(next).toEqual([
              ...previous,
              ...(q >= w ? ['r'] : Array.from({ length: q }, (_, i) => `ssh:h${i}\0r`)),
              ...Array.from({ length: Math.max(0, q - w) }, (_, i) => `own-${w + i}`)
            ])
            let matcherBuilds = 0
            let matcherTokenVisits = 0
            const nextIterator = next[Symbol.iterator].bind(next)
            next[Symbol.iterator] = function* () {
              matcherBuilds++
              for (const id of { [Symbol.iterator]: nextIterator }) {
                matcherTokenVisits++
                yield id
              }
            }
            visits = 0
            hostReads = 0
            const selection = projectFilterSelection(index, next)
            const readVisits = visits
            expect(readVisits).toBe(n + unrelated)
            expect(selection.fullKeys).toEqual([group.key])
            expect(selection.unresolved).toEqual(previous.slice())
            let rowReads = 0
            const rows = Array.from({ length: n }, (_, i) => ({
              ...row(`w${i}`, authored[i].id, `ssh:h${i}`),
              get repoId() {
                rowReads++
                return authored[i].id
              }
            }))
            const shown = filterWorktrees(
              rows,
              { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: next },
              ''
            )
            expect(shown.map((item) => item.worktreeId)).toEqual(
              Array.from({ length: q }, (_, i) => `w${i}`)
            )
            expect(rowReads).toBe(n)
            expect(matcherBuilds).toBe(2)
            expect(matcherTokenVisits).toBe(2 * next.length)
            process.stdout.write(
              `F1 operations ${JSON.stringify({ n, q, w, unrelated, f, groupingReads, groupingPathReads, groupingPathChars, publicationVisits, publicationHostReads, publicationPathReads, effectiveAddressVisits, editVisits, editHostReads, readVisits, editBuildCount, editInputVisits, matcherBuilds, matcherTokenVisits, rowReads, output: shown.length })}\n`
            )
          }
        }
      }
    }
  }
)

it('publishes original folded aliases under their actual containing group and retains server-local filter meaning', () => {
  const target = { kind: 'environment', environmentId: 'E' } as const
  const authored = [
    {
      id: 'a',
      displayName: 'A',
      path: '/same',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local' as const
    },
    {
      id: 'b',
      displayName: 'B',
      path: '/same',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local' as const,
      upstream: { owner: 'org', repo: 'app' }
    }
  ]
  const original = projectHostSetupProjectionFromRepos(authored)
  const projection = adoptEndpointProjectCatalog(target, original.projects, original.setups)
  const repos = authored.map((repo) => adoptEndpointRepo(target, repo))
  const model = { projects: projection.projects, projectHostSetups: projection.setups }
  const index = buildProjectGroupingIndex(model)
  expect(index.groups).toHaveLength(1)
  expect(index.groups[0].registrations).toHaveLength(2)
  const published = buildMobileProjectSectionCatalog(
    repos,
    projection,
    'manual',
    [],
    undefined,
    index
  )
  expect(published.setups.map((setup) => setup.groupKey)).toEqual([
    index.groups[0].key,
    index.groups[0].key
  ])
  expect(projectFilterSelection(index, ['runtime:E\0a'])).toMatchObject({
    partialKeys: [index.groups[0].key],
    unresolved: []
  })
  expect(projectFilterSelection(index, ['local\0a'])).toMatchObject({
    matchingKeys: [],
    unresolved: ['local\0a'],
    active: true
  })
})
