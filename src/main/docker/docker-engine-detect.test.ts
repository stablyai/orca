import { describe, expect, it } from 'vitest'
import { detectDockerEngine } from './docker-engine-detect'

describe('detectDockerEngine', () => {
  it('detects Colima on macOS before Docker Desktop', () => {
    const result = detectDockerEngine({
      platform: 'darwin',
      env: { HOME: '/Users/u' },
      existsSync: (candidate) =>
        candidate === '/Users/u/.colima/default/docker.sock' || candidate === '/var/run/docker.sock'
    })
    expect(result).toMatchObject({
      flavor: 'colima',
      socketPath: '/Users/u/.colima/default/docker.sock',
      available: true
    })
  })

  it('falls back to Docker Desktop on macOS', () => {
    const result = detectDockerEngine({
      platform: 'darwin',
      env: { HOME: '/Users/u' },
      existsSync: (candidate) => candidate === '/var/run/docker.sock'
    })
    expect(result).toMatchObject({
      flavor: 'docker-desktop-mac',
      socketPath: '/var/run/docker.sock',
      available: true
    })
  })

  it('detects Linux Docker Engine and rootless sockets', () => {
    expect(
      detectDockerEngine({
        platform: 'linux',
        uid: 501,
        existsSync: (candidate) => candidate === '/var/run/docker.sock'
      })
    ).toMatchObject({ flavor: 'docker-engine-linux', available: true })

    expect(
      detectDockerEngine({
        platform: 'linux',
        uid: 501,
        existsSync: (candidate) => candidate === '/run/user/501/docker.sock'
      })
    ).toMatchObject({
      flavor: 'docker-rootless-linux',
      socketPath: '/run/user/501/docker.sock',
      available: true
    })
  })

  it('detects Docker Desktop WSL2 named pipe on Windows', () => {
    const result = detectDockerEngine({
      platform: 'win32',
      existsSync: (candidate) => candidate === String.raw`\\.\pipe\docker_engine`
    })
    expect(result).toMatchObject({
      flavor: 'docker-desktop-windows-wsl2',
      socketPath: String.raw`\\.\pipe\docker_engine`,
      available: true
    })
  })

  it('returns unavailable info when Docker is missing', () => {
    expect(
      detectDockerEngine({ platform: 'linux', uid: 501, existsSync: () => false })
    ).toMatchObject({
      flavor: 'docker-engine-linux',
      available: false,
      reason: 'Docker Engine socket was not found'
    })
  })
})
