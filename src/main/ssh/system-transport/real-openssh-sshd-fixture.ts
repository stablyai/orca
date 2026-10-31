/** Opt-in ORCA_REAL_OPENSSH_TEST=1 isolates keys/config/ControlPath from ~/.ssh and supplies a user-style ControlMaster. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SystemSshBuildArgsOptions } from './system-ssh-args'

const SSHD = '/usr/sbin/sshd'
export const REAL_OPENSSH_TEST_ENABLED =
  process.env.ORCA_REAL_OPENSSH_TEST === '1' && process.platform !== 'win32' && existsSync(SSHD)

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export function dial(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out')
}

export type RealOpenSshFixture = {
  dir: string
  /** The HOME every session on this sshd sees, never the user's real one. */
  remoteHome: string
  configFile: string
  target: SshTarget
  buildOptions: () => SystemSshBuildArgsOptions
  /** Fixture-configured client for master control commands. */
  ssh: (args: readonly string[]) => string
  /** New logins fail from here on; the open master keeps working, like a login it cannot repeat. */
  refuseNewLogins: () => void
  close: () => Promise<void>
}

export async function startRealOpenSshFixture(
  extra: { sshd?: readonly string[]; client?: readonly string[] } = {}
): Promise<RealOpenSshFixture> {
  // macOS TMPDIR can overflow the ControlPath Unix socket limit; use /tmp there.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-ros-'))
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'hostkey')])
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'clientkey')])
  const authorizedKeys = join(dir, 'authorized_keys')
  copyFileSync(join(dir, 'clientkey.pub'), authorizedKeys)
  chmodSync(authorizedKeys, 0o600)
  const sshdPort = await freePort()
  const remoteHome = join(dir, 'home')
  mkdirSync(remoteHome)
  writeFileSync(
    join(dir, 'sshd_config'),
    [
      `Port ${sshdPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'hostkey')}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      `PidFile ${join(dir, 'sshd.pid')}`,
      `SetEnv HOME=${remoteHome}`,
      ...(extra.sshd ?? [])
    ].join('\n')
  )
  // A valid ControlPath may contain spaces; recovery must preserve them.
  mkdirSync(join(dir, 'control sockets'))
  const controlPath = join(dir, 'control sockets', 'cm-%C')
  const configFile = join(dir, 'ssh_config')
  const target: SshTarget = {
    id: 'real-openssh',
    label: 'real-openssh',
    configHost: 'orca-real-openssh',
    host: 'orca-real-openssh',
    port: 22,
    username: '',
    source: 'ssh-config'
  }
  const alias = 'orca-real-openssh'
  writeFileSync(
    configFile,
    [
      `Host ${alias}`,
      '  HostName 127.0.0.1',
      `  Port ${sshdPort}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${join(dir, 'clientkey')}`,
      '  IdentitiesOnly yes',
      '  UserKnownHostsFile /dev/null',
      '  StrictHostKeyChecking no',
      '  ControlMaster auto',
      `  ControlPath "${controlPath}"`,
      '  ControlPersist 600',
      ...(extra.client ?? []).map((line) => `  ${line}`)
    ].join('\n')
  )
  const sshd: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], {
    stdio: 'ignore'
  })
  const ssh = (args: readonly string[]): string =>
    execFileSync('ssh', ['-F', configFile, ...args, alias], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  await waitFor(() => dial(sshdPort))
  // The user's own master, as `ssh <host>` with ControlMaster auto would leave behind.
  ssh(['-o', 'BatchMode=yes', '-fN'])
  return {
    dir,
    remoteHome,
    configFile,
    target,
    buildOptions: () => ({
      configFile,
      resolvedConfig: {
        hostname: '127.0.0.1',
        port: sshdPort,
        identityFile: [],
        forwardAgent: false,
        identitiesOnly: true,
        proxyUseFdpass: false,
        controlMaster: 'auto',
        controlPath,
        controlPersist: '600'
      }
    }),
    ssh,
    refuseNewLogins: () => writeFileSync(authorizedKeys, ''),
    close: async () => {
      try {
        ssh(['-O', 'exit'])
      } catch {
        /* no master */
      }
      const exited = new Promise((resolve) => sshd.once('exit', resolve))
      sshd.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
      // Master/session children can outlive these commands; wait before removing their files.
      await new Promise((resolve) => setTimeout(resolve, 500))
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
