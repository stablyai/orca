import { describe, expect, it } from 'vitest'
import { UiUpdate } from './client-ui-schemas'
import { WorkspaceCleanup } from './workspace-cleanup-ui-schema'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'

const DISMISSAL = {
  worktreeId: 'wt-1',
  dismissedAt: 1700000000000,
  fingerprint: '2|main|abc|clean|19675',
  classifierVersion: 2
}

describe('workspaceCleanup client-ui schema', () => {
  it('accepts a default browse state', () => {
    const browse = createDefaultWorkspaceCleanupBrowseState()
    const parsed = WorkspaceCleanup.parse({ dismissals: { 'wt-1': DISMISSAL }, browse })

    expect(parsed.browse).toEqual(browse)
    expect(parsed.dismissals['wt-1']).toEqual(DISMISSAL)
  })

  it('still accepts a dismissals-only payload from a client that predates browse', () => {
    expect(WorkspaceCleanup.parse({ dismissals: {} })).toEqual({ dismissals: {} })
  })

  it('preserves the optional host qualifier on a dismissal', () => {
    const qualified = { ...DISMISSAL, executionHostId: 'ssh:ssh-1' }
    const parsed = WorkspaceCleanup.parse({ dismissals: { 'ssh:ssh-1\0wt-1': qualified } })

    expect(parsed.dismissals['ssh:ssh-1\0wt-1']).toEqual(qualified)
  })

  // The wire contract: a NEWER client's filter groups must never fail an older
  // host's schema, or the whole ui.set payload is refused (dismissals included).
  it('accepts a browse state carrying unknown future fields and narrows it', () => {
    const parsed = WorkspaceCleanup.parse({
      dismissals: {},
      browse: {
        version: 7,
        activePresetId: 'suggested',
        futureTopLevelField: ['whatever'],
        filters: {
          query: 'kept',
          futureGroup: { enabled: true },
          activity: { idleSignal: 'invented-signal', idleMinDays: 14 }
        },
        sort: { field: 'invented-column', direction: 'desc' },
        customPresets: []
      }
    })

    expect(parsed.browse?.filters.query).toBe('kept')
    expect(parsed.browse?.filters.activity.idleMinDays).toBe(14)
    expect(parsed.browse?.filters.activity.idleSignal).toBe('last-visited')
    expect(parsed.browse?.sort).toEqual({ field: 'last-activity', direction: 'desc' })
    expect(parsed.browse).not.toHaveProperty('activePresetId')
    expect(parsed.browse).not.toHaveProperty('customPresets')
    expect(parsed.browse).not.toHaveProperty('futureTopLevelField')
  })

  it('carries browse through the full UiUpdate payload without dropping siblings', () => {
    const browse = createDefaultWorkspaceCleanupBrowseState()
    browse.filters.query = 'stale'

    const parsed = UiUpdate.parse({
      sidebarWidth: 320,
      workspaceCleanup: { dismissals: { 'wt-1': DISMISSAL }, browse }
    })

    expect(parsed.sidebarWidth).toBe(320)
    expect(parsed.workspaceCleanup?.browse?.filters.query).toBe('stale')
  })
})
