import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { wrapRemoteCommandForPosixShell, type SshExecOptions } from './ssh-connection-utils'
import { execCommand, isSshCommandExitError } from './ssh-relay-exec-command'
import { readRemoteHomeCommand } from './ssh-remote-commands'
import type { SshConnection } from './ssh-connection'
import { tryResolveViaLoginShell } from './ssh-remote-node-resolution'
import {
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from './ssh-remote-platform'

const LINUX_HOST: RemoteHostPlatform = {
  os: 'linux',
  arch: 'x64',
  relayPlatform: 'linux-x64',
  pathFlavor: 'posix',
  commandDialect: 'posix',
  pathSeparator: '/',
  pathDelimiter: ':'
}

const HOME = '/home/fishu'

/** sshd runs the user's shell with -c; its startup files print before our command runs. */
function hostWithStartupOutput(startupScript: string, env: Record<string, string> = { HOME }) {
  const commands: string[] = []
  const exec = vi.fn()
  exec.mockImplementation(async (command: string, options?: SshExecOptions) => {
    commands.push(command)
    const remote =
      options?.wrapCommand === false ? command : wrapRemoteCommandForPosixShell(command)
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', `${startupScript}\n${remote}`],
      env: { PATH: process.env.PATH, ...env }
    })
    const channel = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stderr: new EventEmitter(),
      close: () => {}
    })
    setImmediate(() => {
      channel.emit('data', Buffer.from(result.stdout))
      channel.emit('close', result.code ?? 1)
    })
    return channel
  })
  return { commands, usesSystemSshTransport: () => false, exec }
}

const STARTUP_NOISE: [string, string][] = [
  ['an rc echo', 'echo FISH-RC-BANNER stdout noise'],
  ['a bare terminal-title escape', String.raw`printf '\033]0;t\007'`],
  ['a banner with no trailing newline', "printf 'motd-without-newline'"]
]

describe.skipIf(process.platform === 'win32')('SSH exec under noisy startup files', () => {
  it.each(STARTUP_NOISE)('reads a valid remote home despite %s', async (_name, startup) => {
    const conn = hostWithStartupOutput(startup)
    const home = normalizeRemoteHome(
      await execCommand(conn, readRemoteHomeCommand(LINUX_HOST)),
      LINUX_HOST
    )
    expect(home).toBe(HOME)
    expect(validateRemoteHome(home, LINUX_HOST)).toBe(true)
  })

  it('keeps token probes exact and the exit code intact', async () => {
    const conn = hostWithStartupOutput('echo OK')
    await expect(execCommand(conn, 'echo MISSING')).resolves.toBe('MISSING\n')

    const failure = await execCommand(conn, 'echo partial; exit 3').catch((error) => error)
    expect(isSshCommandExitError(failure)).toBe(true)
    expect(failure).toMatchObject({ exitCode: 3, stdout: 'partial\n' })
    // The error names the caller's command, not the fence around it.
    expect(failure.message).toContain('"echo partial; exit 3"')
    expect(failure.message).not.toContain('CAPTURE')
  })

  it('keeps a payload that prints its own script text, as a `ps` inventory does', async () => {
    const conn = hostWithStartupOutput('echo OK')
    await expect(
      execCommand(conn, 'ps -o args= -p $$ | tr "\\n" " "; echo; echo DONE')
    ).resolves.toMatch(/\nDONE\n$/)
  })

  it('leaves unwrapped commands for the host shell untouched', async () => {
    const conn = hostWithStartupOutput('')
    await execCommand(conn, 'echo raw', { wrapCommand: false })
    expect(conn.commands).toEqual(['echo raw'])
  })
})

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))(
  'login-shell Node probe under noisy startup files',
  () => {
    it.each(STARTUP_NOISE)(
      'finds a Node only the profile puts on PATH despite %s',
      async (_name, startup) => {
        const home = await mkdtemp(join(tmpdir(), 'orca-login-shell-node-'))
        try {
          const nodePath = join(home, 'custom-node', 'bin', 'node')
          await mkdir(join(home, 'custom-node', 'bin'), { recursive: true })
          await writeFile(nodePath, '#!/bin/sh\necho v22.0.0\n')
          await chmod(nodePath, 0o755)
          // sshd's shell and the nested `bash -l` both print before the probe runs.
          await writeFile(
            join(home, '.bash_profile'),
            `${startup}\nexport PATH='${join(home, 'custom-node', 'bin')}':"$PATH"\n`
          )
          const host = hostWithStartupOutput(startup, { HOME: home, SHELL: '/bin/bash' })
          const checked: string[] = []
          const found = await tryResolveViaLoginShell(
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand only uses exec and usesSystemSshTransport.
            host as unknown as SshConnection,
            async (candidate) => {
              checked.push(candidate)
              return candidate === nodePath ? true : null
            }
          )
          expect(checked).toEqual([nodePath])
          expect(found?.nodePath).toBe(nodePath)
        } finally {
          await rm(home, { recursive: true, force: true })
        }
      }
    )
  }
)
