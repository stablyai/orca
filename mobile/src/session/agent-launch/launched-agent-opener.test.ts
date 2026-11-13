import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-router', () => ({}))

import { getStateFromPath } from 'expo-router/build/fork/getStateFromPath'
import { getMockConfig } from 'expo-router/build/testing-library/mock-config'
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

// The entry Expo Router's own parser leaves on the stack for an href.
function parsedEntry(href: string): { name: string; params?: object } {
  const config = getMockConfig([
    '_layout.tsx',
    'h/_layout.tsx',
    'h/[hostId]/session/[worktreeId].tsx'
  ])
  let entry = getStateFromPath(href, config)?.routes.at(-1)
  while (entry?.state) {
    entry = entry.state.routes.at(-1)
  }
  if (!entry) {
    throw new Error(`no route for ${href}`)
  }
  return entry
}

describe('planLaunchedAgentOpen', () => {
  it('keeps a workspace whose id is another’s percent-encoding apart from it', () => {
    const args = { current: 1, paneKey, shellReturns: true }
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [sessionEntry('a%3Fb'), sourceControl],
        session: { ...session, worktreeId: 'a?b' }
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/a%3Fb?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [sessionEntry('a?b'), sourceControl],
        session: { ...session, worktreeId: 'a%3Fb' }
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/a%253Fb?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [{ ...sessionEntry('wt-a'), params: { hostId: 'h%3Fa', worktreeId: 'wt-a' } }],
        current: 0,
        session: { ...session, hostId: 'h?a' }
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/h%3Fa/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })

  it('returns to a percent-literal workspace through the entry Expo Router parsed for it', () => {
    const args = { current: 1, paneKey, shellReturns: true }
    const literal = parsedEntry('/h/host-a/session/a%253Fb?name=Workspace+A')
    expect(literal.params).toEqual({ hostId: 'host-a', worktreeId: 'a%3Fb', name: 'Workspace A' })
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [literal, sourceControl],
        session: { ...session, worktreeId: 'a%3Fb' }
      })
    ).toEqual({
      kind: 'dismiss-to',
      href: '/h/host-a/session/a%253Fb?name=Workspace+A&paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [literal, sourceControl],
        session: { ...session, worktreeId: 'a?b' }
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/a%3Fb?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
    expect(
      planLaunchedAgentOpen({
        ...args,
        stack: [parsedEntry('/h/host-a/session/a%3Fb'), sourceControl],
        session: { ...session, worktreeId: 'a?b' }
      })
    ).toEqual({
      kind: 'dismiss-to',
      href: '/h/host-a/session/a%3Fb?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })

  it('returns to the session beneath this screen with its own params and the pane', () => {
    expect(
      planLaunchedAgentOpen({
        stack: [sessionEntry('wt-a'), sourceControl],
        current: 1,
        session,
        paneKey,
        shellReturns: true
      })
    ).toEqual({
      kind: 'dismiss-to',
      href: '/h/host-a/session/wt-a?name=Workspace+A&paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })

  it('sets the pane in place when the session is the current screen', () => {
    expect(
      planLaunchedAgentOpen({
        stack: [sessionEntry('wt-a')],
        current: 0,
        session,
        paneKey,
        shellReturns: false
      })
    ).toEqual({ kind: 'set-params' })
  })

  it('leaves another workspace’s session beneath it alone and asks the shell', () => {
    expect(
      planLaunchedAgentOpen({
        stack: [sessionEntry('wt-b'), sourceControl],
        current: 1,
        session,
        paneKey,
        shellReturns: true
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })

  it('treats the same workspace on another execution host as a different session', () => {
    const remote = {
      name: SESSION,
      params: { hostId: 'host-a', worktreeId: 'wt-a', executionHost: 'ssh:box' }
    }
    const args = { stack: [remote, sourceControl], current: 1, paneKey, shellReturns: true }
    expect(planLaunchedAgentOpen({ ...args, session })).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
    expect(
      planLaunchedAgentOpen({ ...args, session: { ...session, executionHost: 'ssh:box' } })
    ).toEqual({
      kind: 'dismiss-to',
      href: '/h/host-a/session/wt-a?executionHost=ssh%3Abox&paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })

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

  it('asks a shell that returns to the session, and offers nothing on one that would push', () => {
    const args = { stack: [sourceControl], current: 0, session, paneKey }
    expect(
      planLaunchedAgentOpen({
        ...args,
        session: { ...session, executionHost: 'ssh:box' as const },
        shellReturns: true
      })
    ).toEqual({
      kind: 'shell',
      href: '/h/host-a/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111&executionHost=ssh%3Abox'
    })
    expect(planLaunchedAgentOpen({ ...args, shellReturns: false })).toEqual({ kind: 'none' })
  })

  it('pushes the session where there is no shell and no entry', () => {
    expect(
      planLaunchedAgentOpen({
        stack: [sourceControl],
        current: 0,
        session,
        paneKey,
        shellReturns: null
      })
    ).toEqual({
      kind: 'push',
      href: '/h/host-a/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'
    })
  })
})
