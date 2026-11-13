import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-router', () => ({}))

import { planLaunchedAgentOpen } from './launched-agent-opener'

const SESSION = '[hostId]/session/[worktreeId]'
const SOURCE_CONTROL = '[hostId]/source-control/[worktreeId]'
const session = { hostId: 'host-a', worktreeId: 'wt-a', executionHost: undefined }
const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
const sessionEntry = (worktreeId: string) => ({
  name: SESSION,
  params: { hostId: 'host-a', worktreeId, name: 'Workspace A', paneKey: '' }
})
const sourceControl = { name: SOURCE_CONTROL, params: { hostId: 'host-a', worktreeId: 'wt-a' } }

describe('planLaunchedAgentOpen', () => {
  it('returns only to the nearest session entry at or beneath this screen', () => {
    const shell = {
      kind: 'shell',
      href: '/h/host-a/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    }
    // Dismissing lands on the nearest session entry, which here shows another workspace.
    expect(
      planLaunchedAgentOpen({
        stack: [sessionEntry('wt-a'), sessionEntry('wt-b'), sourceControl],
        current: 2,
        session,
        paneKey,
        shellReturns: true
      })
    ).toEqual(shell)
    // An entry above this screen is not one to go back to.
    expect(
      planLaunchedAgentOpen({
        stack: [sourceControl, sessionEntry('wt-a')],
        current: 0,
        session,
        paneKey,
        shellReturns: true
      })
    ).toEqual(shell)
  })
})
