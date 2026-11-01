import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execCommand } from './remote-exec/remote-exec-command'
import type * as ExecCommandModule from './remote-exec/remote-exec-command'
import { readSshHostProxyEnvironment } from './ssh-host-proxy-environment'

vi.mock('./remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

const conn = { exec: vi.fn(), usesSystemSshTransport: () => false }
const execMock = vi.mocked(execCommand)

beforeEach(() => {
  execMock.mockReset()
})

describe('readSshHostProxyEnvironment', () => {
  it.skipIf(process.platform === 'win32')(
    'reads the proxy variables a POSIX exec session has',
    async () => {
      execMock.mockImplementation(async (_conn, command) =>
        execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HTTPS_PROXY: 'http://gateway.docker.internal:3128',
            no_proxy: 'localhost\nsecond.internal',
            UNRELATED: 'x'
          }
        })
      )

      await expect(readSshHostProxyEnvironment(conn)).resolves.toEqual({
        HTTPS_PROXY: 'http://gateway.docker.internal:3128',
        no_proxy: 'localhost\nsecond.internal'
      })
    }
  )

  it('falls back to PowerShell when the host is not POSIX, ignoring startup noise', async () => {
    execMock
      .mockRejectedValueOnce(
        Object.assign(new Error("'exec' is not recognized"), { exitCode: 1, stdout: '' })
      )
      .mockResolvedValueOnce(
        `Welcome HTTPS_PROXY=http://wrong\r\n__ORCA_HOST_PROXY_ENV__ HTTP_PROXY=${Buffer.from('http://usér@corp:8080').toString('hex')}\r\n`
      )

    await expect(readSshHostProxyEnvironment(conn)).resolves.toEqual({
      HTTP_PROXY: 'http://usér@corp:8080'
    })
    expect(execMock.mock.calls[1]?.[2]).toMatchObject({ wrapCommand: false })
  })
})
