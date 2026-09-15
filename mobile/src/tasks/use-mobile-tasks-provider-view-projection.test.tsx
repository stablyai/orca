import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearGroupBy,
  LinearIssue,
  LinearIssueSection,
  LinearOrderBy,
  LinearViewMode,
  TaskItem
} from './mobile-tasks-legacy-foundation'
import type { PickerProjectionModel } from './use-mobile-tasks-picker-projection'

// Why: the tasks barrel pulls the whole react-native screen graph in; re-export only the
// linear pieces this hook uses, straight from their leaf modules, and count grouping calls.
const groupingInputSizes: number[] = []

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const { colors } = await import('../theme/mobile-theme')
  const { githubProjectIdentityKey } = await import('../../../src/shared/github/project-identity')
  return {
    useCallback: react.useCallback,
    useMemo: react.useMemo,
    colors,
    githubProjectKey: githubProjectIdentityKey,
    TaskProviderLogo: () => null,
    getLinkedWorkItemSuggestedName: () => ''
  }
})

vi.mock('./mobile-tasks-legacy-foundation', async () => {
  const options = await import('./mobile-tasks-options')
  const linear = await import('./mobile-tasks-reviewer-linear')
  return {
    ...options,
    ...linear,
    groupLinearIssues: (issues: LinearIssue[], groupBy: LinearGroupBy, orderBy: LinearOrderBy) => {
      groupingInputSizes.push(issues.length)
      return linear.groupLinearIssues(issues, groupBy, orderBy)
    },
    groupSortedLinearIssues: (issues: readonly LinearIssue[], groupBy: LinearGroupBy) => {
      groupingInputSizes.push(issues.length)
      return linear.groupSortedLinearIssues(issues, groupBy)
    }
  }
})

const { sortLinearIssues, groupLinearIssues } = await import('./mobile-tasks-legacy-foundation')
const { useMobileTasksProviderViewProjection } =
  await import('./use-mobile-tasks-provider-view-projection')

const STATES = [
  { name: 'Backlog', type: 'backlog', color: '#111111' },
  { name: 'Todo', type: 'unstarted', color: '#222222' },
  { name: 'In Progress', type: 'started', color: '#333333' },
  { name: 'Done', type: 'completed', color: '#444444' }
]
const TEAMS = [
  { id: 'team-a', name: 'Alpha', key: 'ALP' },
  { id: 'team-b', name: 'Beta', key: 'BET' }
]
const ASSIGNEES = [
  { id: 'user-1', displayName: 'Ada' },
  { id: 'user-2', displayName: 'Grace' },
  undefined
]
const GROUPINGS: LinearGroupBy[] = ['none', 'status', 'assignee', 'priority', 'team']
const ORDERINGS: LinearOrderBy[] = ['priority', 'updated', 'identifier']

/** Deterministic issues: every field is a pure function of the index, so grouping,
 *  ordering and comparison counts repeat exactly across runs. */
function makeIssue(index: number): LinearIssue {
  const state = STATES[(index * 3) % STATES.length]!
  const team = TEAMS[(index * 5) % TEAMS.length]!
  return {
    id: `issue-${index}`,
    identifier: `${team.key}-${100 + ((index * 7) % 97)}`,
    title: `Issue ${index}`,
    url: `https://linear.app/issue-${index}`,
    state,
    team,
    labels: [],
    assignee: ASSIGNEES[(index * 2) % ASSIGNEES.length],
    priority: (index * 11) % 5,
    updatedAt: new Date(Date.UTC(2026, 0, 1 + ((index * 13) % 29))).toISOString()
  }
}

function makeItems(count: number): TaskItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    provider: 'linear' as const,
    title: `Issue ${index}`,
    source: makeIssue(index)
  })) as unknown as TaskItem[]
}

type ProbeInput = {
  items: TaskItem[]
  linearGroupBy: LinearGroupBy
  linearOrderBy: LinearOrderBy
  linearViewMode: LinearViewMode
  githubProjectPickerSearch: string
}

const DEFAULT_INPUT: ProbeInput = {
  items: makeItems(50),
  linearGroupBy: 'status',
  linearOrderBy: 'priority',
  linearViewMode: 'list',
  githubProjectPickerSearch: ''
}

/** The hook mutates the model it is handed, so each render gets a fresh envelope around
 *  the same input identities — exactly how the picker projection feeds it in the app. */
function createModel(input: ProbeInput): PickerProjectionModel {
  return {
    activeGitHubProject: null,
    defaultGitHubPreset: 'open',
    githubKind: 'issues',
    githubMode: 'repo',
    githubPreset: 'open',
    githubProjectPickerSearch: input.githubProjectPickerSearch,
    githubProjectSearch: '',
    githubProjectSettings: { pinned: [], recent: [] },
    githubProjectTable: null,
    githubProjects: [],
    gitlabFilter: 'opened',
    hostedRepos: [],
    items: input.items,
    linearDisplayProperties: new Set(['state', 'priority']),
    linearFilter: 'all',
    linearGroupBy: input.linearGroupBy,
    linearOrderBy: input.linearOrderBy,
    linearTeamPropertyTouched: false,
    linearTeams: [],
    linearViewMode: input.linearViewMode,
    linearWorkspaces: [],
    persistRepoSelection: () => {},
    selectedLinearTeamIds: new Set<string>(),
    selectedLinearWorkspaceId: 'all',
    setAppliedGithubProjectSearch: () => {},
    setSelectedRepoIds: () => {}
  } as unknown as PickerProjectionModel
}

type Projection = ReturnType<typeof useMobileTasksProviderViewProjection>

// Why: a stack, not a nullable handle — the react-test-renderer types degrade to `any`
// when mobile dependencies are absent, and a union with them trips the type-aware gate.
const mounted: ReactTestRenderer[] = []
let latest: Projection | null = null
let renderCount = 0

function Probe(props: { input: ProbeInput }): null {
  renderCount += 1
  latest = useMobileTasksProviderViewProjection(createModel(props.input))
  return null
}

function mount(overrides: Partial<ProbeInput> = {}): Projection {
  const input = { ...DEFAULT_INPUT, ...overrides }
  act(() => {
    mounted.push(create(createElement(Probe, { input })))
  })
  return current()
}

function rerender(overrides: Partial<ProbeInput> = {}): Projection {
  const input = { ...DEFAULT_INPUT, ...overrides }
  const renderer = mounted[mounted.length - 1]!
  act(() => renderer.update(createElement(Probe, { input })))
  return current()
}

function unmountAll(): void {
  while (mounted.length > 0) {
    const renderer = mounted.pop()!
    act(() => renderer.unmount())
  }
}

function current(): Projection {
  if (!latest) {
    throw new Error('probe never rendered')
  }
  return latest
}

/** The pre-change board memo, kept verbatim as the parity and count oracle. */
function legacyProjection(input: ProbeInput): {
  issuesForView: LinearIssue[]
  listSections: LinearIssueSection[]
  boardSections: LinearIssueSection[]
} {
  const issuesForView = sortLinearIssues(
    input.items
      .filter(
        (item): item is Extract<TaskItem, { provider: 'linear' }> => item.provider === 'linear'
      )
      .map((item) => item.source),
    input.linearOrderBy
  )
  return {
    issuesForView,
    listSections: groupLinearIssues(issuesForView, input.linearGroupBy, input.linearOrderBy),
    boardSections: groupLinearIssues(
      issuesForView,
      input.linearGroupBy === 'none' ? 'status' : input.linearGroupBy,
      input.linearOrderBy
    )
  }
}

type WorkCounts = { groupingCalls: number; issueVisits: number; comparisons: number }

/** Counts the projection's grouping calls, per-issue grouping visits, and sort-comparator
 *  invocations. Operation counts only — nothing here is time, CPU or memory. */
function countLinearWork(run: () => void): WorkCounts {
  const nativeSort = Array.prototype.sort
  let comparisons = 0
  groupingInputSizes.length = 0
  Array.prototype.sort = function patchedSort<T>(this: T[], compare?: (a: T, b: T) => number) {
    return nativeSort.call(
      this,
      compare &&
        ((a: T, b: T) => {
          comparisons += 1
          return compare(a, b)
        })
    )
  } as typeof Array.prototype.sort
  try {
    run()
  } finally {
    Array.prototype.sort = nativeSort
  }
  return {
    groupingCalls: groupingInputSizes.length,
    issueVisits: groupingInputSizes.reduce((total, size) => total + size, 0),
    comparisons
  }
}

function shape(sections: LinearIssueSection[]) {
  return sections.map((section) => ({
    key: section.key,
    label: section.label,
    color: section.color,
    issues: section.issues.map((issue) => issue.id)
  }))
}

beforeEach(() => {
  latest = null
  renderCount = 0
  groupingInputSizes.length = 0
})

afterEach(() => {
  unmountAll()
})

describe('useMobileTasksProviderViewProjection linear sections', () => {
  it.each(GROUPINGS.filter((groupBy) => groupBy !== 'none'))(
    'reuses the list sections for the board when grouping is %s',
    (linearGroupBy) => {
      const projection = mount({ linearGroupBy })
      expect(projection.linearBoardSections).toBe(projection.linearIssueSections)
      expect(shape(projection.linearBoardSections)).toEqual(
        shape(legacyProjection({ ...DEFAULT_INPUT, linearGroupBy }).boardSections)
      )
    }
  )

  it('keeps a separate status grouping for the board when grouping is none', () => {
    const projection = mount({ linearGroupBy: 'none' })
    const legacy = legacyProjection({ ...DEFAULT_INPUT, linearGroupBy: 'none' })
    expect(projection.linearBoardSections).not.toBe(projection.linearIssueSections)
    expect(shape(projection.linearIssueSections)).toEqual(shape(legacy.listSections))
    expect(shape(projection.linearBoardSections)).toEqual(shape(legacy.boardSections))
    expect(projection.linearIssueSections.map((section) => section.key)).toEqual(['all'])
    expect(projection.linearBoardSections.length).toBeGreaterThan(1)
    expect(projection.linearListEntries.every((entry) => entry.type === 'issue')).toBe(true)
  })

  it.each(ORDERINGS)('matches the pre-change sections for every grouping at order %s', (order) => {
    for (const linearGroupBy of GROUPINGS) {
      const projection = mount({ linearGroupBy, linearOrderBy: order })
      const legacy = legacyProjection({
        ...DEFAULT_INPUT,
        linearGroupBy,
        linearOrderBy: order
      })
      expect(shape(projection.linearIssueSections)).toEqual(shape(legacy.listSections))
      expect(shape(projection.linearBoardSections)).toEqual(shape(legacy.boardSections))
      expect(projection.linearIssuesForView.map((issue) => issue.id)).toEqual(
        legacy.issuesForView.map((issue) => issue.id)
      )
      unmountAll()
    }
  })
})

describe('useMobileTasksProviderViewProjection transitions', () => {
  it('re-derives both section sets across grouping transitions', () => {
    mount({ linearGroupBy: 'none' })
    expect(current().linearBoardSections).not.toBe(current().linearIssueSections)

    const grouped = rerender({ linearGroupBy: 'status' })
    expect(grouped.linearBoardSections).toBe(grouped.linearIssueSections)
    expect(shape(grouped.linearBoardSections)).toEqual(
      shape(legacyProjection({ ...DEFAULT_INPUT, linearGroupBy: 'status' }).boardSections)
    )

    const assignee = rerender({ linearGroupBy: 'assignee' })
    expect(assignee.linearBoardSections).toBe(assignee.linearIssueSections)
    expect(shape(assignee.linearBoardSections)).toEqual(
      shape(legacyProjection({ ...DEFAULT_INPUT, linearGroupBy: 'assignee' }).boardSections)
    )

    const none = rerender({ linearGroupBy: 'none' })
    expect(none.linearBoardSections).not.toBe(none.linearIssueSections)
    expect(shape(none.linearBoardSections)).toEqual(
      shape(legacyProjection({ ...DEFAULT_INPUT, linearGroupBy: 'none' }).boardSections)
    )
  })

  it('re-derives sections when the ordering changes', () => {
    const first = mount({ linearGroupBy: 'priority', linearOrderBy: 'priority' })
    const firstSections = first.linearBoardSections
    const next = rerender({ linearGroupBy: 'priority', linearOrderBy: 'identifier' })
    expect(next.linearBoardSections).not.toBe(firstSections)
    expect(next.linearBoardSections).toBe(next.linearIssueSections)
    expect(shape(next.linearBoardSections)).toEqual(
      shape(
        legacyProjection({
          ...DEFAULT_INPUT,
          linearGroupBy: 'priority',
          linearOrderBy: 'identifier'
        }).boardSections
      )
    )
  })

  it('keeps section identity across an unrelated rerender', () => {
    const first = mount({ linearGroupBy: 'status' })
    const sections = first.linearBoardSections
    const entries = first.linearListEntries
    const after = rerender({ linearGroupBy: 'status', githubProjectPickerSearch: 'orca' })
    expect(renderCount).toBe(2)
    expect(after.linearBoardSections).toBe(sections)
    expect(after.linearIssueSections).toBe(sections)
    expect(after.linearListEntries).toBe(entries)
  })

  it('keeps section identity across a list/board view switch', () => {
    const list = mount({ linearGroupBy: 'team', linearViewMode: 'list' })
    const sections = list.linearBoardSections
    const board = rerender({ linearGroupBy: 'team', linearViewMode: 'board' })
    expect(board.linearBoardSections).toBe(sections)
    expect(board.linearIssueSections).toBe(sections)
  })

  it('rebuilds both section sets when a refresh hands back an equal-but-new array', () => {
    const first = mount({ linearGroupBy: 'status' })
    const sections = first.linearBoardSections
    const refreshed = rerender({ linearGroupBy: 'status', items: makeItems(50) })
    expect(refreshed.linearBoardSections).not.toBe(sections)
    expect(refreshed.linearBoardSections).toBe(refreshed.linearIssueSections)
    expect(shape(refreshed.linearBoardSections)).toEqual(shape(sections))
  })

  it('does not mutate the shared sections when the list entries are built', () => {
    const projection = mount({ linearGroupBy: 'status' })
    const before = shape(projection.linearIssueSections)
    const entryIssueIds = projection.linearListEntries
      .filter((entry) => entry.type === 'issue')
      .map((entry) => (entry.type === 'issue' ? entry.issue.id : ''))
    expect(entryIssueIds).toHaveLength(50)
    expect(shape(projection.linearBoardSections)).toEqual(before)
  })
})

describe('useMobileTasksProviderViewProjection grouping work', () => {
  it('halves the grouping work for a grouped mount against the pre-change projection', () => {
    const input = { ...DEFAULT_INPUT, linearGroupBy: 'status' as const }
    const before = countLinearWork(() => {
      legacyProjection(input)
    })
    const after = countLinearWork(() => {
      mount(input)
    })
    expect(before.groupingCalls).toBe(2)
    expect(after.groupingCalls).toBe(1)
    expect(before.issueVisits).toBe(100)
    expect(after.issueVisits).toBe(50)
    // Both legacy groupings re-sorted an already sorted 50-issue array (n-1 comparisons
    // each); one call is gone and the other groups without re-sorting.
    expect(before.comparisons - after.comparisons).toBe(2 * (input.items.length - 1))
  })

  it('keeps both none grouping calls but drops their re-sorts', () => {
    const input = { ...DEFAULT_INPUT, linearGroupBy: 'none' as const }
    const before = countLinearWork(() => {
      legacyProjection(input)
    })
    const after = countLinearWork(() => {
      mount(input)
    })
    expect([before.groupingCalls, after.groupingCalls]).toEqual([2, 2])
    expect([before.issueVisits, after.issueVisits]).toEqual([100, 100])
    expect(before.comparisons - after.comparisons).toBe(2 * (input.items.length - 1))
  })

  it('does no grouping work on an unrelated rerender', () => {
    mount({ linearGroupBy: 'status' })
    const onRerender = countLinearWork(() => {
      rerender({ linearGroupBy: 'status', githubProjectPickerSearch: 'orca' })
    })
    expect(onRerender).toEqual({ groupingCalls: 0, issueVisits: 0, comparisons: 0 })
  })
})
