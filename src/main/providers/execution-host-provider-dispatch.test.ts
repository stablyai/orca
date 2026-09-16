import { afterEach, describe, expect, it } from 'vitest'
import {
  ExecutionHostNotDispatchableError,
  requireFilesystemProviderForHost,
  requireGitProviderForHost,
  resolveFilesystemRouteForHost,
  resolveGitRouteForHost,
  UnresolvableExecutionHostError
} from './execution-host-provider-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from './ssh-git-dispatch'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from './ssh-filesystem-dispatch'

const connectionId = 'host-dispatch-target'
const gitProvider = { listWorktrees: async () => [] } as never
const filesystemProvider = { readDir: async () => [] } as never

describe('execution host provider dispatch', () => {
  afterEach(() => {
    unregisterSshGitProvider(connectionId)
    unregisterSshFilesystemProvider(connectionId)
  })

  it('routes `local` to the local entry rather than to a provider', () => {
    expect(resolveGitRouteForHost('local')).toEqual({ kind: 'local', hostId: 'local' })
    expect(resolveFilesystemRouteForHost('local')).toEqual({ kind: 'local', hostId: 'local' })
  })

  it('routes an ssh host to its registered provider', () => {
    registerSshGitProvider(connectionId, gitProvider)
    registerSshFilesystemProvider(connectionId, filesystemProvider)

    expect(resolveGitRouteForHost(`ssh:${connectionId}`)).toEqual({
      kind: 'ssh',
      hostId: `ssh:${connectionId}`,
      connectionId,
      provider: gitProvider
    })
    expect(resolveFilesystemRouteForHost(`ssh:${connectionId}`)).toEqual({
      kind: 'ssh',
      hostId: `ssh:${connectionId}`,
      connectionId,
      provider: filesystemProvider
    })
    expect(requireGitProviderForHost(`ssh:${connectionId}`)).toBe(gitProvider)
    expect(requireFilesystemProviderForHost(`ssh:${connectionId}`)).toBe(filesystemProvider)
  })

  it('answers `unreachable`, not `local`, for an ssh host with no registered provider', () => {
    const route = resolveGitRouteForHost(`ssh:${connectionId}`)

    // The distinction the old `connectionId ? ssh : local` shape could not spell.
    expect(route.kind).toBe('ssh')
    expect(route.kind === 'ssh' && route.provider).toBeNull()
    expect(() => requireGitProviderForHost(`ssh:${connectionId}`)).toThrow(
      /Remote connection dropped/
    )
    expect(() => requireFilesystemProviderForHost(`ssh:${connectionId}`)).toThrow(
      /Remote connection dropped/
    )
  })

  it('routes a runtime host to its own entry instead of collapsing it into local', () => {
    expect(resolveGitRouteForHost('runtime:env-7')).toEqual({
      kind: 'runtime',
      hostId: 'runtime:env-7',
      environmentId: 'env-7'
    })
    expect(resolveFilesystemRouteForHost('runtime:env-7')).toEqual({
      kind: 'runtime',
      hostId: 'runtime:env-7',
      environmentId: 'env-7'
    })
  })

  it('refuses to hand a runtime host to this process’s ssh table', () => {
    // A runtime repo row carries the *server's* nested target id. Dialling it here would reach a
    // same-named target in this client's namespace.
    registerSshGitProvider(connectionId, gitProvider)

    expect(() => requireGitProviderForHost('runtime:env-7')).toThrow(
      ExecutionHostNotDispatchableError
    )
    expect(() => requireFilesystemProviderForHost('runtime:env-7')).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it('refuses to serve a local host from the remote-only accessor', () => {
    expect(() => requireGitProviderForHost('local')).toThrow(ExecutionHostNotDispatchableError)
    expect(() => requireFilesystemProviderForHost('local')).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it.each([null, undefined, '', 'nonsense', 'ssh:', 'runtime:', 'ssh:a|b'])(
    'throws instead of answering local for the unresolvable host %p',
    (hostId) => {
      expect(() => resolveGitRouteForHost(hostId)).toThrow(UnresolvableExecutionHostError)
      expect(() => resolveFilesystemRouteForHost(hostId)).toThrow(UnresolvableExecutionHostError)
    }
  )
})
