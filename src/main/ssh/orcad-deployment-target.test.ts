import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseGlibcVersion,
  parseOrcadLinuxLibc,
  resolveOrcadDeploymentTargetFacts
} from './orcad-deployment-target'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

async function resolveOrcadDeploymentTarget(
  options: Parameters<typeof resolveOrcadDeploymentTargetFacts>[0]
): Promise<string> {
  return (await resolveOrcadDeploymentTargetFacts(options)).target
}
beforeEach(() => vi.mocked(execCommand).mockReset())

describe('deployment C library selection', () => {
  it.each([
    ['glibc 2.31', 'linux-x64-glibc'],
    ['musl', 'linux-x64-musl']
  ])('uses host fallback evidence %j when ldd is unavailable', async (evidence, target) => {
    vi.mocked(execCommand).mockResolvedValueOnce('ldd: not found').mockResolvedValueOnce(evidence)
    const conn = new SshConnection(createTarget(), createCallbacks())
    await expect(
      resolveOrcadDeploymentTarget({ conn, host: getRemoteHostPlatform('linux-x64') })
    ).resolves.toBe(target)
    expect(execCommand).toHaveBeenLastCalledWith(
      conn,
      expect.stringContaining('getconf GNU_LIBC_VERSION'),
      expect.anything()
    )
  })

  it('never guesses when neither probe identifies the host library', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    await expect(
      resolveOrcadDeploymentTarget({
        conn: new SshConnection(createTarget(), createCallbacks()),
        host: getRemoteHostPlatform('linux-x64')
      })
    ).rejects.toThrow('Could not identify')
  })

  it('checks connection ownership again before the fallback probe', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    const generation = conn.getConnectGeneration()
    const firstProbe = Promise.withResolvers<string>()
    vi.mocked(execCommand).mockReturnValueOnce(firstProbe.promise)
    const exec = vi.fn(async (command: string) => {
      if (conn.getConnectGeneration() !== generation) {
        throw new Error('SSH connection changed during SQLite runtime setup.')
      }
      return execCommand(conn, command)
    })
    const pending = resolveOrcadDeploymentTarget({
      conn,
      host: getRemoteHostPlatform('linux-x64'),
      exec
    })
    expect(execCommand).toHaveBeenCalledOnce()

    await conn.disconnect()
    firstProbe.resolve('ldd: not found')

    await expect(pending).rejects.toThrow('SSH connection changed')
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining('getconf GNU_LIBC_VERSION'))
    expect(execCommand).toHaveBeenCalledOnce()
  })

  it.each([
    ['ldd (Ubuntu GLIBC 2.31-0ubuntu9) 2.31', 'glibc'],
    ['ldd (GNU libc) 2.28', 'glibc'],
    ['musl libc (x86_64)\nVersion 1.2.5', 'musl']
  ])('recognizes %s', (output, expected) => {
    expect(parseOrcadLinuxLibc(output)).toBe(expected)
  })

  it.each(['', 'ldd: command not found', 'Linux x86_64'])(
    'refuses unproven target %j',
    (output) => {
      expect(() => parseOrcadLinuxLibc(output)).toThrow('Could not identify')
    }
  )

  it.each([
    ['ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31\nCopyright (C) 2020', { major: 2, minor: 31 }],
    ['ldd (GNU libc) 2.17', { major: 2, minor: 17 }],
    ['glibc 2.28', { major: 2, minor: 28 }],
    ['ldd (GNU libc) unknown', null]
  ])('reads glibc major.minor from %j', (output, expected) => {
    expect(parseGlibcVersion(output)).toEqual(expected)
  })

  it('returns the glibc version with the target, from either probe', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    const host = getRemoteHostPlatform('linux-arm64')
    vi.mocked(execCommand).mockResolvedValueOnce('ldd (Debian GLIBC 2.36-9+deb12u4) 2.36')
    await expect(resolveOrcadDeploymentTargetFacts({ conn, host })).resolves.toEqual({
      target: 'linux-arm64-glibc',
      glibc: { major: 2, minor: 36 }
    })
    vi.mocked(execCommand)
      .mockResolvedValueOnce('ldd: not found')
      .mockResolvedValueOnce('glibc 2.27')
    await expect(resolveOrcadDeploymentTargetFacts({ conn, host })).resolves.toEqual({
      target: 'linux-arm64-glibc',
      glibc: { major: 2, minor: 27 }
    })
  })

  it('reports no glibc on musl and non-Linux hosts', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    vi.mocked(execCommand).mockResolvedValueOnce('musl libc (x86_64)\nVersion 1.2.5')
    await expect(
      resolveOrcadDeploymentTargetFacts({ conn, host: getRemoteHostPlatform('linux-x64') })
    ).resolves.toEqual({ target: 'linux-x64-musl', glibc: null })
    await expect(
      resolveOrcadDeploymentTargetFacts({ conn, host: getRemoteHostPlatform('darwin-arm64') })
    ).resolves.toEqual({ target: 'darwin-arm64', glibc: null })
  })
})
