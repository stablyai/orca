import { NO_WORKSPACE_ROW_FILTERS } from '../../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceViewSettingsUpdate,
  INITIAL_MOBILE_VIEW,
  type MobileViewState
} from './workspace-view-settings'

const base: MobileViewState = {
  ...INITIAL_MOBILE_VIEW,
  filters: { ...NO_WORKSPACE_ROW_FILTERS, alwaysShowDefaultBranchWorkspace: false },
  sharesOtherClientFilter: true
}

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
})
