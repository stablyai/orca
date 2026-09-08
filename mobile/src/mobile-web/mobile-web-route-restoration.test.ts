import { describe, expect, it } from 'vitest'
import {
  mobileWebNavigationRouteTarget,
  mobileWebResumeRouteTarget
} from './mobile-web-route-restoration'

describe('mobile web route restoration', () => {
  it('keeps the workspace list as the default recovery route', () => {
    expect(mobileWebResumeRouteTarget({ kind: 'workspaceList' })).toBeNull()
  })

  it('keeps page metadata out of the restored URL', () => {
    expect(
      mobileWebResumeRouteTarget({
        kind: 'session',
        workspaceId: 'opaque/workspace?one',
        workspaceName: 'Feature & tests'
      })
    ).toBe('/h/paired-orca-desktop/session/opaque%2Fworkspace%3Fone')
  })

  it('cannot accept a paired host identity for a page URL', () => {
    expect(mobileWebNavigationRouteTarget).toHaveLength(1)
    expect(mobileWebNavigationRouteTarget({ kind: 'accounts' })).not.toContain(
      'paired-host-public-key'
    )
  })

  it.each([
    [{ kind: 'tasks' } as const, '/h/paired-orca-desktop/tasks'],
    [{ kind: 'tasks', taskSource: 'gitlab' } as const, '/h/paired-orca-desktop/tasks'],
    [{ kind: 'accounts' } as const, '/h/paired-orca-desktop/accounts'],
    [{ kind: 'newWorkspace' } as const, '/']
  ])('maps the typed native destination %s', (route, expected) => {
    expect(mobileWebNavigationRouteTarget(route)).toBe(expected)
  })
})
