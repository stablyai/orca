import { afterEach, describe, expect, it } from 'vitest'
import { activeSessions, getActiveSshHostHomeDirectory } from './ssh-active-relay-sessions'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../worktree-removal-execution-host-route'

const TARGET = 'target-home'

function sessionReporting(remoteHome: string | null): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getRemoteHomeDirectory is the only member the home lookup calls on a session.
  return { getRemoteHomeDirectory: () => remoteHome } as never
}

afterEach(() => {
  activeSessions.delete(TARGET)
  unregisterSshGitProvider(TARGET)
})

describe('getActiveSshHostHomeDirectory', () => {
  it('reports the home the session read on its host', () => {
    activeSessions.set(TARGET, sessionReporting('/srv/homes/alice'))

    expect(getActiveSshHostHomeDirectory(TARGET)).toBe('/srv/homes/alice')
  })

  it('reports an absent session as unknown', () => {
    expect(getActiveSshHostHomeDirectory(TARGET)).toBeNull()
  })

  it('is wired into worktree removal, so an SSH delete asks the host', () => {
    // Pins the module-scope registration: without it the route silently answers
    // `homePath: null` forever and the host home stops protecting anything.
    activeSessions.set(TARGET, sessionReporting('/srv/homes/alice'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider is registered only so the SSH route resolves; the home answer comes from the session, not from git.
    registerSshGitProvider(TARGET, {} as never)

    expect(resolveWorktreeRemovalHome(resolveWorktreeRemovalRoute(`ssh:${TARGET}`))).toEqual({
      kind: 'executionHost',
      homePath: '/srv/homes/alice'
    })
  })
})
