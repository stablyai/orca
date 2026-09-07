import { describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  groupModeFromDesktop,
  groupModeToDesktop,
  sortModeFromDesktop,
  type MobileViewState,
  type WorkspaceViewSettings
} from './workspace-view-settings'

const base: MobileViewState = {
  groupMode: 'repo',
  sortMode: 'recent',
  hideSleeping: false,
  hideDefaultBranch: false,
  filterRepoIds: [],
  collapsedGroups: [],
  workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES
}

describe('group mode mapping', () => {
  it('round-trips every mobile group mode through the desktop value', () => {
    for (const mode of ['none', 'workspaceStatus', 'repo', 'prStatus'] as const) {
      expect(groupModeFromDesktop(groupModeToDesktop(mode))).toBe(mode)
    }
  })

  it('maps the desktop kebab-case values back to mobile', () => {
    expect(groupModeFromDesktop('workspace-status')).toBe('workspaceStatus')
    expect(groupModeFromDesktop('pr-status')).toBe('prStatus')
    expect(groupModeFromDesktop(undefined)).toBeNull()
  })
})

describe('sort mode mapping', () => {
  it('accepts shared sort values and rejects unknown', () => {
    expect(sortModeFromDesktop('manual')).toBe('manual')
    expect(sortModeFromDesktop('smart')).toBe('smart')
    expect(sortModeFromDesktop(undefined)).toBeNull()
    expect(sortModeFromDesktop('bogus' as never)).toBeNull()
  })
})

describe('applyDesktopViewSettings', () => {
  it('applies provided desktop fields and leaves missing ones untouched', () => {
    const next = applyDesktopViewSettings(base, {
      groupBy: 'pr-status',
      hideSleepingWorkspaces: true,
      filterRepoIds: ['repo-1']
    })
    expect(next).toEqual({
      ...base,
      groupMode: 'prStatus',
      hideSleeping: true,
      filterRepoIds: ['repo-1']
    })
  })

  it('keeps current values when the desktop payload is empty', () => {
    expect(applyDesktopViewSettings(base, {})).toEqual(base)
  })

  it('keeps renderable workspace statuses when desktop sends an empty catalog', () => {
    const next = applyDesktopViewSettings(base, { workspaceStatuses: [] })

    expect(next.workspaceStatuses).toBe(DEFAULT_MOBILE_WORKSPACE_STATUSES)
  })

  it('ignores desktop workspace host scope so mobile always shows all hosts', () => {
    // Mobile has no host-scope UI; honoring the synced scope would silently hide
    // workspaces the user cannot unhide. See mobile-show-all-workspace.
    const next = applyDesktopViewSettings(base, {
      workspaceHostScope: 'runtime:devbox',
      visibleWorkspaceHostIds: ['local']
    } as unknown as WorkspaceViewSettings)

    expect(next).toEqual(base)
  })

  it('ignores an unrecognized groupBy rather than blanking the mode', () => {
    const next = applyDesktopViewSettings(base, { groupBy: 'mystery' as never })
    expect(next.groupMode).toBe('repo')
  })
})

describe('buildWorkspaceViewSettingsUpdate', () => {
  const next: MobileViewState = {
    ...base,
    alwaysShowDefaultBranch: true,
    groupMode: 'workspaceStatus',
    sortMode: 'name',
    hideSleeping: true,
    hideDefaultBranch: true,
    filterRepoIds: ['repo-1'],
    collapsedGroups: ['g1']
  }

  it('carries only the fields the patch touched (STA-5781)', () => {
    expect(buildWorkspaceViewSettingsUpdate({ hideSleeping: true }, next)).toEqual({
      hideSleepingWorkspaces: true
    })
    expect(buildWorkspaceViewSettingsUpdate({ groupMode: 'workspaceStatus' }, next)).toEqual({
      groupBy: 'workspace-status'
    })
    expect(buildWorkspaceViewSettingsUpdate({ collapsedGroups: ['g1'] }, next)).toEqual({
      collapsedGroups: ['g1']
    })
  })

  it('maps a multi-field reset patch without dragging untouched siblings along', () => {
    const update = buildWorkspaceViewSettingsUpdate(
      { hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] },
      { ...next, hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] }
    )
    expect(update).toEqual({
      hideSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: false,
      filterRepoIds: []
    })
  })

  it('never invents alwaysShowDefaultBranchWorkspace for patches that omit it (#8873)', () => {
    expect(
      'alwaysShowDefaultBranchWorkspace' in
        buildWorkspaceViewSettingsUpdate({ hideSleeping: true }, next)
    ).toBe(false)
  })

  it('returns an empty update for an empty patch', () => {
    expect(buildWorkspaceViewSettingsUpdate({}, next)).toEqual({})
  })
})
