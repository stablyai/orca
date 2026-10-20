/**
 * Real OpenSSH: a forward process must own its listener and see sshd's refusals even when the
 * user's ssh_config multiplexes through a ControlMaster. Opt-in (needs sshd and ssh on PATH):
 * ORCA_REAL_OPENSSH_TEST=1 pnpm test src/main/ssh/system-transport/system-ssh-forward-process-real-openssh.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../connection/ssh-connection'
import { SystemSshPortForwardProvider } from '../port-forwarding/system-ssh-port-forward-provider'
import { checkForwardChannel } from '../ssh-tcp-forwarding-probe'
import { startSystemSshPortForwardProcess } from './system-ssh-forward-process'

const SSHD = '/usr/sbin/sshd'
const enabled =
  process.env.ORCA_REAL_OPENSSH_TEST === '1' && process.platform !== 'win32' && existsSync(SSHD)

function freePort(): Promise<number> {
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

function dial(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out')
}

describe.skipIf(!enabled)(
  'system SSH forward process under a user ControlMaster (real OpenSSH)',
  () => {
    let dir = ''
    let configFile = ''
    let controlPath = ''
    let sshd: ChildProcess | null = null
    // A port sshd's PermitOpen does not allow, so opening a channel to it is administratively refused.
    let prohibitedPort = 0

    const target: SshTarget = {
      id: 'real-openssh',
      label: 'real-openssh',
      configHost: 'orca-real-openssh',
      host: 'orca-real-openssh',
      port: 22,
      username: '',
      source: 'ssh-config'
    }
    const buildOptions = () => ({
      configFile,
      logChannelFailures: true,
      resolvedConfig: {
        hostname: '127.0.0.1',
        port: 22,
        identityFile: [],
        forwardAgent: false,
        identitiesOnly: true,
        proxyUseFdpass: false,
        controlMaster: 'auto',
        controlPath,
        controlPersist: '600'
      }
    })

    beforeAll(async () => {
      // Why /tmp: a ControlPath under macOS's long TMPDIR overflows the unix socket path limit.
      dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-ros-'))
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'hostkey')])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'clientkey')])
      copyFileSync(join(dir, 'clientkey.pub'), join(dir, 'authorized_keys'))
      chmodSync(join(dir, 'authorized_keys'), 0o600)
      const sshdPort = await freePort()
      prohibitedPort = await freePort()
      writeFileSync(
        join(dir, 'sshd_config'),
        [
          `Port ${sshdPort}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${join(dir, 'hostkey')}`,
          `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'UsePAM no',
          'StrictModes no',
          `PidFile ${join(dir, 'sshd.pid')}`,
          'PermitOpen 127.0.0.1:1'
        ].join('\n')
      )
      controlPath = join(dir, 'cm-%C')
      configFile = join(dir, 'ssh_config')
      writeFileSync(
        configFile,
        [
          `Host ${target.configHost}`,
          '  HostName 127.0.0.1',
          `  Port ${sshdPort}`,
          `  User ${userInfo().username}`,
          `  IdentityFile ${join(dir, 'clientkey')}`,
          '  IdentitiesOnly yes',
          `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
          '  StrictHostKeyChecking no',
          '  ControlMaster auto',
          `  ControlPath ${controlPath}`,
          '  ControlPersist 600'
        ].join('\n')
      )
      sshd = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' })
      await waitFor(() => dial(sshdPort))
      // The user's own master, as `ssh <host>` with ControlMaster auto would leave behind.
      execFileSync('ssh', ['-F', configFile, '-o', 'BatchMode=yes', '-fN', target.configHost!], {
        stdio: 'ignore'
      })
    }, 30_000)

    afterAll(() => {
      try {
        execFileSync('ssh', ['-F', configFile, '-O', 'exit', target.configHost!], {
          stdio: 'ignore'
        })
      } catch {
        /* no master */
      }
      sshd?.kill('SIGTERM')
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('closing the forward releases its listener', async () => {
      const forward = await startSystemSshPortForwardProcess(
        target,
        0,
        '127.0.0.1',
        prohibitedPort,
        buildOptions()
      )
      await forward.waitForStartup()
      expect(await dial(forward.localPort)).toBe(true)
      await forward.close()
      expect(await dial(forward.localPort)).toBe(false)
    }, 20_000)

    // Why: an older Orca forwarded through this master, which keeps the listener once that client
    // exits, so the port is held with no process of Orca's left for the orphan sweep to find.
    it('rebinds a fixed port a master still holds for a forward Orca left muxed', async () => {
      const heldPort = await freePort()
      execFileSync('ssh', [
        '-F',
        configFile,
        '-O',
        'forward',
        '-L',
        `127.0.0.1:${heldPort}:127.0.0.1:${prohibitedPort}`,
        target.configHost!
      ])
      expect(await dial(heldPort)).toBe(true)

      const forward = await startSystemSshPortForwardProcess(
        target,
        heldPort,
        '127.0.0.1',
        prohibitedPort,
        buildOptions()
      )
      try {
        await forward.waitForStartup()
        expect(forward.localPort).toBe(heldPort)
        expect(await dial(heldPort)).toBe(true)
      } finally {
        await forward.close()
      }
      expect(await dial(heldPort)).toBe(false)
    }, 20_000)

    it("sees sshd's administrative refusal on its own stderr", async () => {
      const conn = {
        getTarget: () => target,
        getSystemSshBuildArgsOptions: buildOptions
      } satisfies Pick<SshConnection, 'getTarget' | 'getSystemSshBuildArgsOptions'>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the system SSH provider's start reads only getTarget and getSystemSshBuildArgsOptions.
      const connection = conn as unknown as SshConnection
      const started = await new SystemSshPortForwardProvider().start(connection, {
        id: 'pf-real',
        connectionId: target.id,
        localHost: '127.0.0.1',
        localPort: 0,
        remoteHost: '127.0.0.1',
        remotePort: prohibitedPort
      })
      try {
        expect(await checkForwardChannel(started)).toBe('refused')
      } finally {
        await started.close()
      }
    }, 20_000)
  }
)
