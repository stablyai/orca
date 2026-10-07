import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOrcadRuntimeTarget } from './orcad-runtime-target'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
beforeEach(() => vi.mocked(execCommand).mockReset())

function resolveOn(platform: Parameters<typeof getRemoteHostPlatform>[0], ldd: string) {
  vi.mocked(execCommand).mockResolvedValueOnce(ldd)
  return resolveOrcadRuntimeTarget({
    conn: new SshConnection(createTarget(), createCallbacks()),
    host: getRemoteHostPlatform(platform)
  })
}

describe('managed orcad runtime target', () => {
  it.each([
    ['CentOS 7 (glibc 2.17)', 'ldd (GNU libc) 2.17', 'linux-x64-glibc217'],
    ['glibc 2.27, still below the default floor', 'ldd (GNU libc) 2.27', 'linux-x64-glibc217'],
    ['Debian 10 (glibc 2.28)', 'ldd (Debian GLIBC 2.28-10+deb10u2) 2.28', 'linux-x64-glibc'],
    ['Ubuntu 22.04 (glibc 2.35)', 'ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35', 'linux-x64-glibc'],
    ['Alpine (musl)', 'musl libc (x86_64)\nVersion 1.2.5', 'linux-x64-musl']
  ])('deploys %s on the runtime the relay ladder would pick', async (_host, ldd, target) => {
    await expect(resolveOn('linux-x64', ldd)).resolves.toBe(target)
  })

  it('keeps the host target when the glibc version is unreadable; the self-test decides', async () => {
    await expect(resolveOn('linux-x64', 'ldd (GNU libc) unknown')).resolves.toBe('linux-x64-glibc')
  })

  it('refuses as unsupported where no runtime serves the glibc, so the connect keeps the relay', async () => {
    await expect(resolveOn('linux-arm64', 'ldd (GNU libc) 2.17')).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError',
      message: expect.stringContaining('linux-arm64-glibc with glibc 2.17')
    })
    await expect(resolveOn('linux-x64', 'ldd (GNU libc) 2.12')).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError'
    })
  })

  it('needs no libc probe off Linux', async () => {
    await expect(
      resolveOrcadRuntimeTarget({
        conn: new SshConnection(createTarget(), createCallbacks()),
        host: getRemoteHostPlatform('darwin-arm64')
      })
    ).resolves.toBe('darwin-arm64')
    expect(execCommand).not.toHaveBeenCalled()
  })
})
