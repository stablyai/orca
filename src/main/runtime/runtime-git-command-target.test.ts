import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionHostNotDispatchableError } from '../providers/execution-host-provider-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  localGitOptionsForTarget,
  requireRuntimeGitProvider,
  runtimeGitRouteForTarget,
  type RuntimeGitTarget
} from './runtime-git-command-target'

const worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/srv/app',
  git: { path: '/srv/app', branch: 'main', isBare: false, isMainWorktree: false }
} as unknown as RuntimeGitTarget['worktree']

function target(overrides: Partial<RuntimeGitTarget>): RuntimeGitTarget {
  return { worktree, executionHostId: 'local', ...overrides }
}

describe('runtime Git target routing', () => {
  const registered: string[] = []

  function register(connectionId: string) {
    const provider = { getStatus: async () => ({ entries: [] }) }
    registerSshGitProvider(connectionId, provider as never)
    registered.push(connectionId)
    return provider
  }

  afterEach(() => {
    for (const connectionId of registered.splice(0)) {
      unregisterSshGitProvider(connectionId)
    }
  })

  it('routes each ssh host to its own provider', () => {
    const m4air = register('m4air')
    const openclaw = register('openclaw')

    expect(runtimeGitRouteForTarget(target({ executionHostId: 'ssh:m4air' }))).toEqual({
      kind: 'ssh',
      connectionId: 'm4air',
      provider: m4air
    })
    expect(requireRuntimeGitProvider(target({ executionHostId: 'ssh:openclaw' }))).toBe(openclaw)
  })

  it('answers `local` with no provider, which is the only meaning `null` carries', () => {
    expect(runtimeGitRouteForTarget(target({}))).toEqual({ kind: 'local' })
    expect(requireRuntimeGitProvider(target({}))).toBeNull()
  })

  // Loss of contact is never evidence of locality (docs/reference/ssh-execution-boundary.md).
  it('keeps an unreachable ssh host remote instead of degrading it to local', () => {
    const route = runtimeGitRouteForTarget(target({ executionHostId: 'ssh:gone' }))

    expect(route).toEqual({ kind: 'ssh', connectionId: 'gone', provider: null })
    expect(() => requireRuntimeGitProvider(target({ executionHostId: 'ssh:gone' }))).toThrow(
      /Remote connection dropped/
    )
  })

  it('refuses a runtime host even when a same-named target is registered here', () => {
    register('nested-1')

    expect(() => runtimeGitRouteForTarget(target({ executionHostId: 'runtime:env-a' }))).toThrow(
      ExecutionHostNotDispatchableError
    )
    expect(() => requireRuntimeGitProvider(target({ executionHostId: 'runtime:env-a' }))).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it('keeps WSL routing on the local host and off every other one', () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }

    expect(localGitOptionsForTarget(target({ localGitOptions }))).toEqual(localGitOptions)
    expect(
      localGitOptionsForTarget(target({ executionHostId: 'ssh:m4air', localGitOptions }))
    ).toEqual({})
    expect(
      localGitOptionsForTarget(target({ executionHostId: 'runtime:env-a', localGitOptions }))
    ).toEqual({})
  })
})
