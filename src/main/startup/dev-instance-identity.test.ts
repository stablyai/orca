import { describe, expect, it } from 'vitest'
import { createDevDockBadgeLabel, getDevInstanceIdentity } from './dev-instance-identity'

describe('dev-instance-identity', () => {
  it('keeps packaged identity stable', () => {
    expect(getDevInstanceIdentity(false, {})).toMatchObject({
      name: 'Orca',
      isDev: false,
      devLabel: null,
      dockBadgeLabel: null,
      appUserModelId: 'com.stablyai.orca'
    })
  })

  it('derives a readable dev label from worktree and branch env', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_REPO_ROOT: '/repo/worktrees/dev-indicator',
      ORCA_DEV_WORKTREE_NAME: 'dev-indicator',
      ORCA_DEV_BRANCH: 'nwparker/dev-indicator'
    })

    expect(identity).toMatchObject({
      isDev: true,
      devLabel: 'dev-indicator',
      devBranch: 'nwparker/dev-indicator',
      devWorktreeName: 'dev-indicator',
      devRepoRoot: '/repo/worktrees/dev-indicator'
    })
    expect(identity.name).toMatch(/^Orca Dev \[DI[A-Z0-9]{2}\]: nwparker\/dev-indicator$/)
    expect(identity.dockBadgeLabel).toMatch(/^DI[A-Z0-9]{2}$/)
    expect(identity.appUserModelId).toMatch(/^com\.stablyai\.orca\.dev\.[a-f0-9]{10}$/)
  })

  it('includes the branch when it differs from the worktree basename', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_REPO_ROOT: '/repo/worktrees/payment-ui',
      ORCA_DEV_WORKTREE_NAME: 'payment-ui',
      ORCA_DEV_BRANCH: 'feature/billing-shell'
    })

    expect(identity.devLabel).toBe('payment-ui @ feature/billing-shell')
    expect(identity.name).toMatch(/^Orca Dev \[PU[A-Z0-9]{2}\]: feature\/billing-shell$/)
    expect(identity.dockBadgeLabel).toMatch(/^PU[A-Z0-9]{2}$/)
  })

  it('allows an explicit label override', () => {
    const identity = getDevInstanceIdentity(true, {
      ORCA_DEV_INSTANCE_LABEL: 'manual label',
      ORCA_DEV_WORKTREE_NAME: 'dev-indicator',
      ORCA_DEV_BRANCH: 'feature/other'
    })

    expect(identity.devLabel).toBe('manual label')
    expect(identity.name).toMatch(/^Orca Dev \[DI[A-Z0-9]{2}\]: feature\/other$/)
    expect(identity.dockBadgeLabel).toMatch(/^DI[A-Z0-9]{2}$/)
  })

  it('creates compact alphanumeric Dock labels with stable collision suffixes', () => {
    expect(createDevDockBadgeLabel('dev-indicator', '/repo/a')).toMatch(/^DI[A-Z0-9]{2}$/)
    expect(createDevDockBadgeLabel('feature/singleword', '/repo/a')).toMatch(/^SI[A-Z0-9]{2}$/)
    expect(createDevDockBadgeLabel('pr-123', '/repo/a')).toMatch(/^P1[A-Z0-9]{2}$/)
    expect(createDevDockBadgeLabel('dev-indicator', '/repo/a')).not.toBe(
      createDevDockBadgeLabel('dev-indicator', '/repo/b')
    )
  })
})
