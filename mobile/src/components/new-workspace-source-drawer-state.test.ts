import { describe, expect, it } from 'vitest'
import { getAvailableWorkspaceSourceFilters } from '../workspace-source/workspace-source-availability'

describe('new workspace source drawer filters', () => {
  it('shows only source kinds supported by the selected repository state', () => {
    expect(
      getAvailableWorkspaceSourceFilters({ github: false, branches: false, linear: true })
    ).toEqual(['all', 'linear'])
    expect(
      getAvailableWorkspaceSourceFilters({ github: true, branches: true, linear: false })
    ).toEqual(['all', 'github', 'branches'])
  })
})
