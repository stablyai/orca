import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => {
    throw new Error('AppEnvironment not initialized')
  }
}))
import { relayBundleCandidates } from './relay-bundle-paths'

afterEach(() => vi.unstubAllEnvs())

it('lists the WSL guest bundle dirs in the order the WSL relays searched them', () => {
  vi.stubEnv('ORCA_RELAY_PATH', join('/env', 'relay'))
  const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true })
  try {
    expect(relayBundleCandidates('wsl', '/app')).toEqual([
      join('/env', 'relay', 'wsl'),
      join('/res', 'relay', 'wsl'),
      join('/res', 'app.asar.unpacked', 'out', 'relay', 'wsl'),
      join('/app', 'resources', 'relay', 'wsl'),
      join('/app', 'out', 'relay', 'wsl')
    ])
    // No app environment (tests, early startup): the env and resources dirs still resolve.
    expect(relayBundleCandidates('wsl')).toEqual([
      join('/env', 'relay', 'wsl'),
      join('/res', 'relay', 'wsl'),
      join('/res', 'app.asar.unpacked', 'out', 'relay', 'wsl')
    ])
  } finally {
    if (resources) {
      Object.defineProperty(process, 'resourcesPath', resources)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
  }
})
