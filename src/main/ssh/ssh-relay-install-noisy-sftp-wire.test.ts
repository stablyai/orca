import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Server as Ssh2Server, utils, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { spawnProcess } from '../../shared/child-process/run-process'
import { SshConnection } from './ssh-connection'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

type NoisyHost = { port: number; subsystems: number; execs: number; close: () => Promise<void> }

/** sshd starts an external sftp-server and every exec through the user's noisy login shell. */
async function startNoisyHost(startupOutput: string): Promise<NoisyHost> {
  const connections = new Set<Connection>()
  const hostKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private
  const host = { subsystems: 0, execs: 0 }
  const server = new Ssh2Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (context) => context.accept())
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession()
        // No 'sftp' listener: ssh2 hands the raw subsystem channel here, as an external server.
        session.on('subsystem', (accept) => {
          host.subsystems += 1
          const channel = accept()
          channel.on('error', () => {})
          channel.write(startupOutput)
        })
        session.on('exec', (accept, _reject, info) => {
          host.execs += 1
          const channel = accept()
          const child = spawnProcess({
            program: '/bin/sh',
            args: ['-c', `printf %s '${startupOutput.replace(/'/g, `'\\''`)}'\n${info.command}`],
            env: { PATH: process.env.PATH }
          })
          channel.pipe(child.stdin)
          child.stdout.pipe(channel, { end: false })
          child.stderr.pipe(channel.stderr, { end: false })
          child.on('close', (code) => {
            channel.exit(code ?? 1)
            channel.end()
          })
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('SSH fixture did not bind a TCP port')
  }
  return Object.assign(host, {
    port: address.port,
    close: async () => {
      for (const connection of connections) {
        connection.end()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

function connectClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client))
    client.once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port,
      username: 'fixture',
      hostVerifier: () => true,
      readyTimeout: 5_000
    })
  })
}

function connectionWithClient(client: Client): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: transfers read only id/host fields of the target.
  const target = { id: 'noisy-sftp', host: '127.0.0.1', port: 22, username: 'fixture' } as SshTarget
  const connection = new SshConnection(target, { onStateChange: vi.fn() })
  // Inject the already-connected client, as the SFTP wire test does.
  Object.assign(connection, { client, useSystemSshTransport: false })
  return connection
}

const NOISE: [string, string][] = [
  ['an rc banner', 'BASHRC-NOISE\n'],
  ['a bare terminal-title escape', '\u001b]0;t\u0007']
]

describe.skipIf(process.platform === 'win32')(
  'relay install over a noisy external SFTP server',
  () => {
    let localDir: string
    let remoteRoot: string
    beforeEach(async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      localDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-noisy-sftp-local-')))
      remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'orca-noisy-sftp-remote-')))
      await mkdir(join(localDir, 'nested'))
      await writeFile(join(localDir, 'nested', 'payload.bin'), Buffer.from([0, 1, 2, 255]))
    })
    afterEach(async () => {
      await rm(localDir, { recursive: true, force: true })
      await rm(remoteRoot, { recursive: true, force: true })
    })

    it.each(NOISE)(
      'streams the install over exec stdin despite %s',
      async (_name, noise) => {
        const host = await startNoisyHost(noise)
        const client = await connectClient(host.port)
        try {
          const conn = connectionWithClient(client)
          const linux = getRemoteHostPlatform('linux-x64')
          const remoteDir = join(remoteRoot, 'relay')
          await uploadRelayDirectory(conn, localDir, remoteDir, linux)
          await writeRelayFile(conn, linux, join(remoteDir, '.version'), '0.1.0+noisy')

          expect(await readFile(join(remoteDir, 'nested', 'payload.bin'))).toEqual(
            Buffer.from([0, 1, 2, 255])
          )
          expect(await readFile(join(remoteDir, '.version'), 'utf8')).toBe('0.1.0+noisy')
          // The corrupted handshake is a host verdict: the second write skips SFTP entirely.
          expect(host.subsystems).toBe(1)
          expect(host.execs).toBeGreaterThan(0)
        } finally {
          client.end()
          await host.close()
        }
      },
      15_000
    )
  }
)
