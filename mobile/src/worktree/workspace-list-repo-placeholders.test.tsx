import { join } from 'node:path'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSections, type Section, type Worktree } from './workspace-list-sections'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'
import { useWorkspaceSections } from './use-workspace-sections'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

const NO_FILTERS = {
  filterRepoIds: new Set<string>(),
  hideSleeping: false,
  hideDefaultBranch: false
}

const REPO_IDS = new Map([
  ['orca', 'repo-1'],
  ['orca-cloud', 'repo-2'],
  ['repo-test', 'repo-3']
])

describe('repo placeholder sections while the catalog is loading', () => {
  it('emits no placeholder sections before the worktree rows have loaded', () => {
    expect(
      buildSections(
        [],
        'manual',
        NO_FILTERS,
        '',
        'repo',
        new Set(),
        REPO_IDS,
        DEFAULT_MOBILE_WORKSPACE_STATUSES,
        new Set(),
        false
      )
    ).toEqual([])
  })

  it('emits placeholder sections once the rows are loaded and a repo is genuinely empty', () => {
    const sections = buildSections(
      [worktree()],
      'manual',
      NO_FILTERS,
      '',
      'repo',
      new Set(),
      REPO_IDS,
      DEFAULT_MOBILE_WORKSPACE_STATUSES,
      new Set(),
      true
    )

    expect(sections.map((section) => [section.title, section.data.length])).toEqual([
      ['orca', 1],
      ['orca-cloud', 0],
      ['repo-test', 0]
    ])
  })
})

let renderedSections: Section[] = []

function SectionsProbe(props: { displayWorktrees: Worktree[]; worktreesLoaded: boolean }): null {
  const { sections } = useWorkspaceSections({
    displayWorktrees: props.displayWorktrees,
    sortMode: 'manual',
    filters: NO_FILTERS,
    search: '',
    groupMode: 'repo',
    pinnedIds: new Set(),
    repoIdsByName: REPO_IDS,
    repoColorsByName: new Map(),
    collapsedGroups: new Set(),
    workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES,
    worktreesLoaded: props.worktreesLoaded
  })
  renderedSections = sections
  return null
}

function titledCounts(sections: Section[]): [string, number][] {
  return sections.map((section) => [section.title, section.data.length])
}

describe('useWorkspaceSections during a host catalog load', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    renderedSections = []
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders nothing until the rows arrive, never a header skeleton with zero counts', () => {
    // Repo metadata wins the race against the paged workspace snapshot on the hosted page.
    act(() => {
      renderer = create(
        createElement(SectionsProbe, { displayWorktrees: [], worktreesLoaded: false })
      )
    })
    expect(renderedSections).toEqual([])

    act(() => {
      renderer?.update(
        createElement(SectionsProbe, { displayWorktrees: [worktree()], worktreesLoaded: true })
      )
    })
    expect(titledCounts(renderedSections)).toEqual([
      ['orca', 1],
      ['orca-cloud', 0],
      ['repo-test', 0]
    ])
  })
})
