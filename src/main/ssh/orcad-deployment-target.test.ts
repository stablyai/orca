import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOrcadLinuxLibc, resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
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
})
