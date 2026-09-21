import { afterEach, describe, expect, it } from 'vitest'
import {
  registerSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE,
  unregisterSshGitProvider
} from './providers/ssh-git-dispatch'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from './providers/ssh-filesystem-dispatch'
import { ExecutionHostNotDispatchableError } from './providers/execution-host-provider-dispatch'
import {
  getWorktreeRemovalConnectionId,
  resolveWorktreeRemovalRoute
} from './worktree-removal-execution-host-route'

const HOST_A = 'target-a'
const HOST_B = 'target-b'

function gitProvider(name: string): never {
  return { name } as never
}

function fsProvider(name: string): never {
  return { name } as never
}

afterEach(() => {
  unregisterSshGitProvider(HOST_A)
  unregisterSshGitProvider(HOST_B)
  unregisterSshFilesystemProvider(HOST_A)
  unregisterSshFilesystemProvider(HOST_B)
})

describe('resolveWorktreeRemovalRoute', () => {
  it('routes a local host to this machine with no connection', () => {
    const route = resolveWorktreeRemovalRoute('local')

    expect(route).toEqual({ kind: 'local', hostId: 'local' })
    expect(getWorktreeRemovalConnectionId(route)).toBeUndefined()
  })

  it('keeps two simultaneously registered SSH hosts on their own providers', () => {
    registerSshGitProvider(HOST_A, gitProvider('git-a'))
    registerSshGitProvider(HOST_B, gitProvider('git-b'))
    registerSshFilesystemProvider(HOST_A, fsProvider('fs-a'))
    registerSshFilesystemProvider(HOST_B, fsProvider('fs-b'))

    const routeA = resolveWorktreeRemovalRoute('ssh:target-a')
    const routeB = resolveWorktreeRemovalRoute('ssh:target-b')

    expect(routeA).toMatchObject({
      kind: 'ssh',
      hostId: 'ssh:target-a',
      connectionId: HOST_A,
      provider: { name: 'git-a' },
      fsProvider: { name: 'fs-a' }
    })
    expect(routeB).toMatchObject({
      kind: 'ssh',
      hostId: 'ssh:target-b',
      connectionId: HOST_B,
      provider: { name: 'git-b' },
      fsProvider: { name: 'fs-b' }
    })
    expect(getWorktreeRemovalConnectionId(routeA)).toBe(HOST_A)
    expect(getWorktreeRemovalConnectionId(routeB)).toBe(HOST_B)
  })

  it('carries a null filesystem provider without falling back to the local one', () => {
    registerSshGitProvider(HOST_A, gitProvider('git-a'))

    expect(resolveWorktreeRemovalRoute('ssh:target-a')).toMatchObject({
      kind: 'ssh',
      fsProvider: null
    })
  })

  it('refuses an unreachable SSH host instead of answering local', () => {
    expect(() => resolveWorktreeRemovalRoute('ssh:target-a')).toThrow(
      SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
    )
  })

  it('refuses a runtime host with no nested SSH target', () => {
    expect(() => resolveWorktreeRemovalRoute('runtime:env-1')).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it('refuses a runtime host even when a same-named target is dialable here', () => {
    // The nested target lives in the environment's namespace; a same-named local one is a
    // different machine, and removing a worktree through it deletes the wrong checkout.
    registerSshGitProvider(HOST_A, gitProvider('git-a'))

    expect(() => resolveWorktreeRemovalRoute('runtime:target-a')).toThrow(
      ExecutionHostNotDispatchableError
    )
  })
})
