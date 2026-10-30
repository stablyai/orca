import { describe, expect, it } from 'vitest'
import {
  ExecutionHostNotDispatchableError,
  requireReachableFilesystemRoute,
  requireReachableGitRoute,
  resolveFilesystemRouteForHost,
  resolveGitRouteForHost,
  UnresolvableExecutionHostError
} from './execution-host-provider-dispatch'
import { createLocalFilesystemProvider } from './local-filesystem-provider'
import { createLocalGitProvider } from './local-git-provider'
import { SSH_HOST_NOT_SERVED_MESSAGE, SshHostNotServedError } from './ssh-host-not-served-error'

const connectionId = 'host-dispatch-target'

describe('execution host provider dispatch', () => {
  it('routes `local` to a per-call local provider factory, never a cached provider', () => {
    expect(resolveGitRouteForHost('local')).toEqual({
      kind: 'local',
      hostId: 'local',
      createProvider: createLocalGitProvider
    })
    expect(resolveFilesystemRouteForHost('local')).toEqual({
      kind: 'local',
      hostId: 'local',
      createProvider: createLocalFilesystemProvider
    })
  })

  it('routes an ssh host to a provider-less entry', () => {
    const expected = {
      kind: 'ssh',
      hostId: `ssh:${connectionId}`,
      connectionId
    }
    expect(resolveGitRouteForHost(`ssh:${connectionId}`)).toStrictEqual(expected)
    expect(resolveFilesystemRouteForHost(`ssh:${connectionId}`)).toStrictEqual(expected)
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

  it.each([null, undefined, '', 'nonsense', 'ssh:', 'runtime:', 'ssh:a|b'])(
    'throws instead of answering local for the unresolvable host %p',
    (hostId) => {
      expect(() => resolveGitRouteForHost(hostId)).toThrow(UnresolvableExecutionHostError)
      expect(() => resolveFilesystemRouteForHost(hostId)).toThrow(UnresolvableExecutionHostError)
    }
  )

  describe('reachable routes for work this process runs', () => {
    it('keeps `local` explicit', () => {
      expect(requireReachableGitRoute('local')).toMatchObject({ kind: 'local', hostId: 'local' })
      expect(requireReachableFilesystemRoute('local')).toMatchObject({ kind: 'local' })
    })

    it('throws the typed not-served error for an ssh host', () => {
      for (const require of [requireReachableGitRoute, requireReachableFilesystemRoute]) {
        expect(() => require(`ssh:${connectionId}`)).toThrow(SshHostNotServedError)
        expect(() => require(`ssh:${connectionId}`)).toThrow(
          'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
        )
      }
      expect(SSH_HOST_NOT_SERVED_MESSAGE).toBe(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    })

    it('never hands an ssh host a local provider factory', () => {
      expect(resolveGitRouteForHost(`ssh:${connectionId}`)).not.toHaveProperty('createProvider')
      expect(resolveFilesystemRouteForHost(`ssh:${connectionId}`)).not.toHaveProperty(
        'createProvider'
      )
    })

    it('refuses a runtime host', () => {
      expect(() => requireReachableGitRoute('runtime:env-7')).toThrow(
        ExecutionHostNotDispatchableError
      )
      expect(() => requireReachableFilesystemRoute('runtime:env-7')).toThrow(
        ExecutionHostNotDispatchableError
      )
    })
  })
})
