import type * as ExecCommandModule from './remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOrcadDeploymentTargetFacts } from './orcad-deployment-target'
import { SshConnection } from './connection/ssh-connection'
import { createCallbacks, createTarget } from './connection/ssh-connection-test-fixtures'
import { execCommand } from './remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// Captured from the official DS920+ DSM 7.4.1-90080 firmware's dynamic loader.
const SYNOLOGY_LOADER_VERSION =
  'ld.so (GNU libc) stable release version 2.36.\nCopyright (C) 2022 Free Software Foundation, Inc.\n'

vi.mock('./remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

async function resolveOrcadDeploymentTarget(
  options: Parameters<typeof resolveOrcadDeploymentTargetFacts>[0]
): Promise<string> {
  return (await resolveOrcadDeploymentTargetFacts(options)).target
}
beforeEach(() => vi.mocked(execCommand).mockReset())

describe('deployment C library selection', () => {
  it.each([
    ['glibc 2.31', 'linux-x64-glibc'],
    ['musl libc', 'linux-x64-musl']
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

  it('never guesses when no probe identifies the host library', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    await expect(
      resolveOrcadDeploymentTarget({
        conn: new SshConnection(createTarget(), createCallbacks()),
        host: getRemoteHostPlatform('linux-x64')
      })
    ).rejects.toThrow('Could not identify')
  })

  it('identifies DSM through its loader when ldd and getconf are missing', async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce('/bin/sh: ldd: command not found\n')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(SYNOLOGY_LOADER_VERSION)
    const conn = new SshConnection(createTarget(), createCallbacks())
    await expect(
      resolveOrcadDeploymentTargetFacts({ conn, host: getRemoteHostPlatform('linux-x64') })
    ).resolves.toEqual({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 36 } })
  })

  it('propagates loss of contact during the loader probe', async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce('ldd: not found')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('SSH connection changed'))
    const conn = new SshConnection(createTarget(), createCallbacks())
    await expect(
      resolveOrcadDeploymentTargetFacts({ conn, host: getRemoteHostPlatform('linux-x64') })
    ).rejects.toThrow('SSH connection changed')
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
