import { describe, expect, it } from 'vitest'

import { hostNewWorktreeSessionRoute } from './host-new-worktree-session-route'

describe('host new worktree session route', () => {
  it('preserves opaque host and worktree ids after creation', () => {
    expect(hostNewWorktreeSessionRoute('relay/one#50%', 'repo/one#20%', 'Relay workspace')).toBe(
      '/h/relay%2Fone%2350%25/session/repo%2Fone%2320%25?name=Relay+workspace&created=1'
    )
  })

  // Why: the host reports a create that succeeded with a failed startup terminal via `warning`;
  // dropping it here is what lands the phone on an unexplained empty session.
  it('carries a host create warning into the session route', () => {
    expect(
      hostNewWorktreeSessionRoute(
        'local',
        'wt-1',
        'Hammerhead',
        'Failed to create the startup terminal'
      )
    ).toBe(
      '/h/local/session/wt-1?name=Hammerhead&created=1&warning=Failed+to+create+the+startup+terminal'
    )
  })

  it('omits an absent or blank create warning', () => {
    expect(hostNewWorktreeSessionRoute('local', 'wt-1', 'Hammerhead', '   ')).toBe(
      '/h/local/session/wt-1?name=Hammerhead&created=1'
    )
    expect(hostNewWorktreeSessionRoute('local', 'wt-1', 'Hammerhead')).toBe(
      '/h/local/session/wt-1?name=Hammerhead&created=1'
    )
  })
})
