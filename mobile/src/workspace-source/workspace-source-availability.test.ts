import { describe, expect, it } from 'vitest'
import { MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  getWorkspaceSourceAvailability,
  supportsMobileWorkspaceSourceSelector
} from './workspace-source-availability'

describe('workspace source capability gating', () => {
  it('fails closed while status is loading and on older hosts', () => {
    expect(supportsMobileWorkspaceSourceSelector(null)).toBe(false)
    expect(supportsMobileWorkspaceSourceSelector([])).toBe(false)
  })

  it('keeps Linear available for folder and disconnected SSH repositories', () => {
    const capabilities = [MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY]
    expect(
      getWorkspaceSourceAvailability({
        capabilities,
        repoKind: 'folder',
        repoConnected: true,
        linearConnected: true
      })
    ).toEqual({ github: false, branches: false, linear: true })
    expect(
      getWorkspaceSourceAvailability({
        capabilities,
        repoKind: 'git',
        repoConnected: false,
        linearConnected: true
      })
    ).toEqual({ github: false, branches: false, linear: true })
  })
})
