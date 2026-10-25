import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../src/shared/workspace-statuses'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  INITIAL_MOBILE_VIEW,
  rowFiltersForView,
  type MobileViewState,
  type WorkspaceViewSettings
} from './workspace-view-settings'

const base: MobileViewState = {
  ...INITIAL_MOBILE_VIEW,
  filters: { ...NO_WORKSPACE_ROW_FILTERS, alwaysShowDefaultBranchWorkspace: false },
  sharesOtherClientFilter: true
}

describe('the other-client filter on an older desktop', () => {
  it('hides marked rows when the desktop keeps the filter to itself, as its marks are its verdict', () => {
    expect(rowFiltersForView({ ...base, sharesOtherClientFilter: false })).toMatchObject({
      hideWorkspacesFromOtherDevices: true
    })
    expect(rowFiltersForView(base).hideWorkspacesFromOtherDevices).toBe(false)
  })

  it('does not hide marked rows before the first ui.get says which kind of desktop it is', () => {
    expect(rowFiltersForView(INITIAL_MOBILE_VIEW).hideWorkspacesFromOtherDevices).toBe(false)
  })

  it('learns from each ui.get whether the desktop shares the filter', () => {
    expect(applyDesktopViewSettings(base, {}).sharesOtherClientFilter).toBe(false)
    expect(
      applyDesktopViewSettings(base, { hideWorkspacesFromOtherDevices: false })
        .sharesOtherClientFilter
    ).toBe(true)
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
      groupBy: 'pr-status',
      sharesOtherClientFilter: false,
      filters: { ...base.filters, hideSleepingWorkspaces: true, filterRepoIds: ['repo-1'] }
    })
  })

  it('keeps current values when the desktop payload is empty', () => {
    expect(applyDesktopViewSettings(base, {})).toEqual({ ...base, sharesOtherClientFilter: false })
  })

  it('keeps renderable workspace statuses when desktop sends an empty catalog', () => {
    const next = applyDesktopViewSettings(base, { workspaceStatuses: [] })

    expect(next.workspaceStatuses).toBe(DEFAULT_WORKSPACE_STATUSES)
  })

  it("falls back to the desktop's legacy host scope when no host list is saved", () => {
    const scoped = applyDesktopViewSettings(base, {
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'ssh:box'
    })
    expect(scoped.filters.visibleHostIds).toEqual(['ssh:box'])
    expect(
      applyDesktopViewSettings(scoped, { visibleWorkspaceHostIds: null, workspaceHostScope: 'all' })
        .filters.visibleHostIds
    ).toBeNull()
  })

  it("reads the desktop's shown hosts into the host filter, and null as every host", () => {
    const scoped = applyDesktopViewSettings(base, { visibleWorkspaceHostIds: ['local'] })
    expect(scoped.filters.visibleHostIds).toEqual(['local'])
    expect(
      applyDesktopViewSettings(scoped, { visibleWorkspaceHostIds: null }).filters.visibleHostIds
    ).toBeNull()
  })

  it('ignores an unrecognized groupBy rather than blanking the mode', () => {
    const newerGroup: WorkspaceViewSettings = JSON.parse('{"groupBy":"mystery"}')
    const next = applyDesktopViewSettings(base, newerGroup)
    expect(next.groupBy).toBe('repo')
    // A sort a newer desktop adds arrives untyped over the wire.
    const newerSort: WorkspaceViewSettings = JSON.parse('{"sortBy":"bogus"}')
    expect(applyDesktopViewSettings(base, newerSort).sortBy).toBe('recent')
  })
})

describe('buildWorkspaceViewSettingsUpdate', () => {
  const apply = (filters: Partial<MobileViewState['filters']>): MobileViewState => ({
    ...base,
    filters: { ...base.filters, ...filters }
  })

  it('carries only the fields the patch touched (STA-5781)', () => {
    expect(
      buildWorkspaceViewSettingsUpdate(
        { filters: { hideSleepingWorkspaces: true } },
        apply({ hideSleepingWorkspaces: true })
      )
    ).toEqual({ hideSleepingWorkspaces: true })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { groupBy: 'workspace-status' },
        { ...base, groupBy: 'workspace-status' }
      )
    ).toEqual({ groupBy: 'workspace-status' })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { collapsedGroups: ['g1'] },
        { ...base, collapsedGroups: ['g1'] }
      )
    ).toEqual({ collapsedGroups: ['g1'] })
  })

  it('writes each filter under its desktop name, the host scope included', () => {
    const filters = {
      hideAutomationGeneratedWorkspaces: true,
      visibleHostIds: ['local' as const]
    }
    expect(buildWorkspaceViewSettingsUpdate({ filters }, apply(filters))).toEqual({
      hideAutomationGeneratedWorkspaces: true,
      visibleWorkspaceHostIds: ['local'],
      workspaceHostScope: 'local'
    })
  })

  it('leaves the legacy host scope alone for a several-host list', () => {
    const filters = { visibleHostIds: ['local' as const, 'ssh:box' as const] }
    expect(buildWorkspaceViewSettingsUpdate({ filters }, apply(filters))).toEqual({
      visibleWorkspaceHostIds: ['local', 'ssh:box']
    })
  })

  it('sends every filter a full reset names, even ones the phone already thinks are off', () => {
    const update = buildWorkspaceViewSettingsUpdate(
      { filters: NO_WORKSPACE_ROW_FILTERS },
      apply(NO_WORKSPACE_ROW_FILTERS)
    )
    expect(update).toEqual({
      hideSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: true,
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      filterRepoIds: [],
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all'
    })
  })

  it('never invents alwaysShowDefaultBranchWorkspace for edits that leave it alone (#8873)', () => {
    expect(
      'alwaysShowDefaultBranchWorkspace' in
        buildWorkspaceViewSettingsUpdate(
          { filters: { hideSleepingWorkspaces: true } },
          apply({ hideSleepingWorkspaces: true })
        )
    ).toBe(false)
  })

  it('returns an empty update for an empty patch', () => {
    expect(buildWorkspaceViewSettingsUpdate({}, base)).toEqual({})
  })
})

describe('card view settings', () => {
  it('reads the shared card values and writes a hand-picked property set as no longer a preset', () => {
    const next = applyDesktopViewSettings(base, {
      projectOrderBy: 'recent',
      worktreeCardProperties: ['pr'],
      agentActivityDisplayMode: 'full'
    })
    expect([
      next.projectOrderBy,
      next.worktreeCardProperties,
      next.agentActivityDisplayMode
    ]).toEqual(['recent', ['pr'], 'full'])
    expect(
      buildWorkspaceViewSettingsUpdate(
        { worktreeCardProperties: ['pr', 'host'] },
        {
          ...next,
          worktreeCardProperties: ['pr', 'host']
        }
      )
    ).toEqual({ worktreeCardProperties: ['pr', 'host'], _worktreeCardModeDefaulted: false })
  })

  it('writes a Card layout preset as one, and leaves the layout setting out of ui.set', () => {
    const next = {
      ...base,
      worktreeCardProperties: ['status'] as const,
      compactWorktreeCards: true
    }
    expect(
      buildWorkspaceViewSettingsUpdate(
        { worktreeCardProperties: next.worktreeCardProperties, compactWorktreeCards: true },
        next,
        { cardLayoutPreset: true }
      )
    ).toEqual({ worktreeCardProperties: ['status'], _worktreeCardModeDefaulted: true })
  })

  it('keeps the card settings a ui.get does not carry', () => {
    const current = { ...base, compactWorktreeCards: true, newCardStyle: true }
    expect(applyDesktopViewSettings(current, { groupBy: 'none' })).toMatchObject({
      compactWorktreeCards: true,
      newCardStyle: true
    })
  })
})
