import type * as ExecCommandModule from '../../remote-exec/remote-exec-command'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../connection/ssh-connection'
import { getRemoteHostPlatform } from '../ssh-remote-platform'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('../../remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: execCommandMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { resolveRemoteNodePath } = await import('./ssh-remote-node-resolution')

const conn = {} as SshConnection

function loginShellAnswer(output: string) {
  return async (_conn: SshConnection, command: string): Promise<string> => {
    const begin = (/__ORCA_SSH_LOGIN_CAPTURE_BEGIN_ \w+?__/.exec(command)?.[0] ?? '').replace(
      ' ',
      ''
    )
    const end = (/__ORCA_SSH_LOGIN_CAPTURE_END_ \w+?__/.exec(command)?.[0] ?? '').replace(' ', '')
    return `RC-BANNER\n${begin}${output}${end}`
  }
}

describe('resolveRemoteNodePath', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('skips an incomplete system Node and selects a complete NVM toolchain', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/bin/node\n/home/u/.nvm/versions/node/v22.22.0/bin/node\n')
      .mockRejectedValueOnce(new Error('/usr/bin/npm: not found'))
      .mockResolvedValueOnce('__ORCA_NODE_VERSION__\nv22.22.0\n__ORCA_NPM_VERSION__\n11.13.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v22.22.0/bin/node'
    )
  })

  it.runIf(process.platform !== 'win32')('accepts npm elsewhere on PATH', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-split-node-npm-'))
    try {
      const nodePath = path.join(root, 'selected node', 'bin', 'node')
      const npmBinDir = path.join(root, 'npm elsewhere', 'bin')
      mkdirSync(path.dirname(nodePath), { recursive: true })
      mkdirSync(npmBinDir, { recursive: true })
      writeFileSync(nodePath, '#!/bin/sh\nprintf "v22.22.0\\n"\n')
      writeFileSync(path.join(npmBinDir, 'npm'), '#!/bin/sh\nprintf "11.13.0\\n"\n')
      chmodSync(nodePath, 0o755)
      chmodSync(path.join(npmBinDir, 'npm'), 0o755)

      execCommandMock
        .mockResolvedValueOnce(`${nodePath}\n${path.join(root, 'fallback', 'bin', 'node')}\n`)
        .mockImplementationOnce((_conn: SshConnection, command: string) =>
          Promise.resolve(
            execFileSync('/bin/sh', ['-c', command], {
              encoding: 'utf8',
              env: { HOME: root, PATH: npmBinDir }
            })
          )
        )

      await expect(resolveRemoteNodePath(conn)).resolves.toBe(nodePath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds node under a MISE_DATA_DIR exported from a shell dotfile', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.local/share/mise/shims/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-mise-probe-'))
    try {
      const shimPath = path.join(home, 'custom-mise/shims/node')
      const installPath = path.join(home, 'custom-mise/installs/node/v20.11.0/bin/node')
      for (const target of [shimPath, installPath]) {
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, '#!/bin/sh\nprintf "v20.11.0\\n"\n')
        chmodSync(target, 0o755)
      }
      writeFileSync(path.join(home, '.zshrc'), 'export MISE_DATA_DIR=~/custom-mise\n')

      const output = execFileSync('/bin/sh', ['-c', callScript], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' }
      })

      const lines = output.split('\n')
      expect(lines).toContain(shimPath)
      expect(lines).toContain(installPath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('expands an $XDG_DATA_HOME-relative MISE_DATA_DIR assignment from shell dotfiles', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.local/share/mise/shims/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-xdg-probe-'))
    try {
      // A name the seeded `${XDG_DATA_HOME:-$HOME/.local/share}/mise` default cannot reach, so
      // only the dotfile arm can find it.
      const nodePath = path.join(home, 'xdg-data/custom-mise/installs/node/20.11.0/bin/node')
      mkdirSync(path.dirname(nodePath), { recursive: true })
      writeFileSync(nodePath, '#!/bin/sh\nprintf "v20.11.0\\n"\n')
      chmodSync(nodePath, 0o755)
      writeFileSync(path.join(home, '.zshrc'), 'export MISE_DATA_DIR=$XDG_DATA_HOME/custom-mise\n')

      const output = execFileSync('/bin/sh', ['-c', callScript], {
        encoding: 'utf8',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          XDG_DATA_HOME: path.join(home, 'xdg-data')
        }
      })

      expect(output.split('\n')).toContain(nodePath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to the POSIX default when an $XDG_DATA_HOME assignment has no env value', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.local/share/mise/shims/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-xdg-default-probe-'))
    try {
      // sshd's exec channel runs without the profile, so XDG_DATA_HOME is often simply absent.
      const nodePath = path.join(home, '.local/share/custom-mise/installs/node/20.11.0/bin/node')
      mkdirSync(path.dirname(nodePath), { recursive: true })
      writeFileSync(nodePath, '#!/bin/sh\nprintf "v20.11.0\\n"\n')
      chmodSync(nodePath, 0o755)
      writeFileSync(path.join(home, '.zshrc'), 'export MISE_DATA_DIR=$XDG_DATA_HOME/custom-mise\n')

      const output = execFileSync('/bin/sh', ['-c', callScript], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' }
      })

      expect(output.split('\n')).toContain(nodePath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to the login shell when every path-probe candidate is too old', async () => {
    execCommandMock
      .mockResolvedValueOnce('/old/node\n')
      .mockResolvedValueOnce('v10.24.1\n')
      .mockResolvedValueOnce('/bin/bash')
      .mockImplementationOnce(loginShellAnswer('/home/u/.nvm/versions/node/v20.11.0/bin/node\n'))
      .mockResolvedValueOnce('v20.11.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )
  })

  it('surfaces an AbortError instead of not-found when the shared signal is aborted', async () => {
    // Shared bootstrap abort must remain cancellation; swallowing it as Node-not-found defeats sequential fallback.
    const controller = new AbortController()
    const abortError = Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
    execCommandMock.mockImplementation(() => {
      controller.abort()
      return Promise.reject(abortError)
    })

    await expect(
      resolveRemoteNodePath(conn, undefined, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not stop Windows node discovery after the first existing candidate', async () => {
    execCommandMock
      .mockResolvedValueOnce('C:\\old\\node.exe\nC:\\Program Files\\nodejs\\node.exe\n')
      .mockResolvedValueOnce('v16.20.2\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await expect(resolveRemoteNodePath(conn, getRemoteHostPlatform('win32-x64'))).resolves.toBe(
      'C:/Program Files/nodejs/node.exe'
    )
  })
})
