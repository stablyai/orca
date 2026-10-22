import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { readRuntimeEdgeAuth } from '../credentials/runtime-edge-auth-store'
import { resolveRuntimeEnvironmentConnection } from './runtime-environment-edge-auth'
vi.mock('../credentials/runtime-edge-auth-store', () => {
  const read = vi.fn()
  return { readRuntimeEdgeAuth: read, readCachedRuntimeEdgeAuth: read }
})
const environment = createEnvironmentFromPairingOffer({
  id: 'env-1',
  name: 'test',
  now: 1,
  offer: {
    v: 2,
    endpoint: 'wss://orca.example',
    deviceToken: 'synthetic-device',
    publicKeyB64: 'synthetic-key'
  }
})
const edgeAuth = {
  origin: 'wss://orca.example',
  hostPublicKeyB64: 'synthetic-key',
  headers: { 'X-Token': 'synthetic-secret' }
}
beforeEach(() => {
  vi.mocked(readRuntimeEdgeAuth).mockReset()
})
describe('main environment edge credential resolution', () => {
  it('attaches protected credentials only to the matching direct secure connection', () => {
    vi.mocked(readRuntimeEdgeAuth).mockReturnValue(edgeAuth)
    expect(resolveRuntimeEnvironmentConnection('/private/profile', environment).edgeAuth).toEqual(
      edgeAuth
    )
    expect(readRuntimeEdgeAuth).toHaveBeenCalledWith('/private/profile', environment)
  })
  it('keeps headerless secure connections unchanged', () => {
    vi.mocked(readRuntimeEdgeAuth).mockReturnValue(null)
    expect(
      resolveRuntimeEnvironmentConnection('/private/profile', environment).edgeAuth
    ).toBeUndefined()
  })
  it('refuses unreadable credentials rather than silently reconnecting without them', () => {
    vi.mocked(readRuntimeEdgeAuth).mockImplementation(() => {
      throw new Error('Could not read edge authentication')
    })
    expect(() => resolveRuntimeEnvironmentConnection('/private/profile', environment)).toThrow(
      'Could not read edge authentication'
    )
  })
  it('checks the binding even when a store adapter supplies it', () => {
    vi.mocked(readRuntimeEdgeAuth).mockReturnValue({ ...edgeAuth, hostPublicKeyB64: 'wrong' })
    expect(() => resolveRuntimeEnvironmentConnection('/private/profile', environment)).toThrow(
      'Invalid edge authentication'
    )
  })
  it.each(['plain', 'ssh', 'wsl'] as const)(
    'does not read or attach credentials to %s execution paths',
    (kind) => {
      const changed =
        kind === 'plain'
          ? {
              ...environment,
              endpoints: environment.endpoints.map((entry) => ({
                ...entry,
                endpoint: 'ws://127.0.0.1:7777'
              }))
            }
          : kind === 'ssh'
            ? { ...environment, connectionDependency: 'ssh-tunnel' as const }
            : {
                ...environment,
                orcadDeployment: {
                  kind: 'wsl' as const,
                  distro: 'Ubuntu',
                  localPort: 7777,
                  remotePort: 7777
                }
              }
      expect(
        resolveRuntimeEnvironmentConnection('/private/profile', changed).edgeAuth
      ).toBeUndefined()
      expect(readRuntimeEdgeAuth).not.toHaveBeenCalled()
    }
  )
})
