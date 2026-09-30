// Why this exists (STA-6674): a Linux host whose only unreachable endpoint is nodejs.org could
// not run a relay. node-pty ships no Linux prebuild, so npm hands it to node-gyp, and node-gyp
// downloads `node-v<ver>-headers.tar.gz` unless told the host already has the headers -- which
// every official Node install does, at `<prefix>/include/node`. This drives the real deploy at a
// Docker sshd whose nodejs.org resolves to 127.0.0.1 (ECONNREFUSED, exactly what the user saw).
//
// Run: ORCA_REVIEW_SSH_OFFLINE_HEADERS=1 pnpm test src/main/ssh/ssh-relay-offline-node-headers.docker.test.ts
// Needs Docker and `pnpm build:relay`. ORCA_REVIEW_SSH_NODE_IMAGE picks the Node image
// (default node:24.12.0-bookworm, the user's version); ORCA_REVIEW_SSH_TARGET_HOST overrides
// the address the app connects to (default 127.0.0.1).
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import type { SshTarget } from '../../shared/ssh-types'

const RUN_REVIEW_ORACLE = process.env.ORCA_REVIEW_SSH_OFFLINE_HEADERS === '1'
const NODE_IMAGE = process.env.ORCA_REVIEW_SSH_NODE_IMAGE ?? 'node:24.12.0-bookworm'
const TARGET_HOST = process.env.ORCA_REVIEW_SSH_TARGET_HOST ?? '127.0.0.1'

type TargetFixture = {
  containerName: string
  identityFile: string
  port: number
  tempDir: string
}

function run(command: string, args: string[], timeout = 30_000, input?: string): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout,
    input
  }).trim()
}

function dockerExec(fixture: TargetFixture, command: string): string {
  return run('docker', ['exec', fixture.containerName, 'bash', '-lc', command], 60_000)
}

async function startTarget(): Promise<TargetFixture> {
  const image = `orca-review-offline-headers:${NODE_IMAGE.replace(/[^A-Za-z0-9_.-]/g, '-')}`
  run(
    'docker',
    ['build', '-q', '-t', image, '-'],
    600_000,
    [
      `FROM ${NODE_IMAGE}`,
      'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server git && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh',
      ''
    ].join('\n')
  )
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-offline-headers-ssh-'))
  const identityFile = join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-offline-headers-${randomUUID().slice(0, 12)}`
  // Why a refused connection and not a dropped one: a timeout takes node-gyp's retry path and
  // burns the deploy budget; the user's host refused, and that is the path under test.
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '--add-host',
      'nodejs.org:127.0.0.1',
      '-p',
      '0.0.0.0::22',
      '-e',
      `AUTHORIZED_KEY=${publicKey}`,
      image,
      'bash',
      '-lc',
      'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e'
    ],
    120_000
  )
  const port = Number(run('docker', ['port', containerName, '22/tcp']).split(':').at(-1))
  // `docker run -d` returns before sshd binds; connect() against a closed port is a flake.
  await waitForSshBanner(port)
  return { containerName, identityFile, port, tempDir }
}

/** Resolves once sshd answers with its banner on the mapped port, or throws after the deadline. */
async function waitForSshBanner(port: number, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const gotBanner = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: TARGET_HOST, port })
      const done = (value: boolean): void => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(2_000, () => done(false))
      socket.once('data', (chunk) => done(chunk.toString('utf8').startsWith('SSH-')))
      socket.once('error', () => done(false))
    })
    if (gotBanner) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`sshd on port ${port} did not answer within ${deadlineMs / 1000}s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function stopTarget(fixture: TargetFixture | null): void {
  if (!fixture) {
    return
  }
  spawnSync('docker', ['rm', '-f', fixture.containerName], { stdio: 'ignore', timeout: 30_000 })
  rmSync(fixture.tempDir, { recursive: true, force: true })
}

function createConnection(fixture: TargetFixture): SshConnection {
  const target: SshTarget = {
    id: `offline-headers-${randomUUID()}`,
    label: 'Offline node headers Docker SSH target',
    source: 'manual',
    host: TARGET_HOST,
    port: fixture.port,
    username: 'root',
    identityFile: fixture.identityFile,
    identitiesOnly: true
  }
  return new SshConnection(target, { onStateChange: vi.fn() })
}

describe.skipIf(!RUN_REVIEW_ORACLE)(
  'SSH relay deploy on a host that cannot reach nodejs.org',
  () => {
    let fixture: TargetFixture | null = null

    beforeAll(async () => {
      fixture = await startTarget()
    }, 900_000)

    afterAll(() => {
      stopTarget(fixture)
    })

    it('compiles node-pty from the host Node install headers instead of downloading them', async () => {
      const activeFixture = fixture as TargetFixture
      expect(dockerExec(activeFixture, 'getent hosts nodejs.org')).toContain('127.0.0.1')
      const connection = createConnection(activeFixture)
      await connection.connect()
      try {
        const result = await deployAndLaunchRelay(connection, undefined, 60)
        expect(result.remoteRelayDir).toBeTruthy()

        const evidence = dockerExec(
          activeFixture,
          [
            `cd '${result.remoteRelayDir}'`,
            'test -f node_modules/node-pty/build/Release/pty.node && echo PTY_NODE=built',
            'test -d /root/.cache/node-gyp && echo HEADERS=downloaded || echo HEADERS=local',
            `node -e "require('node-pty'); require('@parcel/watcher'); console.log('NATIVE=loadable')"`
          ].join('; ')
        )
        console.log(`[offline-node-headers] ${NODE_IMAGE}: ${evidence.replace(/\n/g, ' ')}`)
        expect(evidence).toContain('PTY_NODE=built')
        expect(evidence).toContain('HEADERS=local')
        expect(evidence).toContain('NATIVE=loadable')
      } finally {
        await connection.disconnect()
      }
    }, 600_000)

    it('names the missing-local-headers cause, not an Orca defect, when the host ships no headers', async () => {
      // Same offline host, headers removed and the relay uninstalled so the deploy compiles again.
      // This is the shape a review found misreported: the exec-failure message quotes the whole
      // command (marker echo included) ahead of the output, and the parser must not read that copy.
      const activeFixture = fixture as TargetFixture
      dockerExec(
        activeFixture,
        'rm -rf /usr/local/include/node /root/.orca-remote /root/.cache/node-gyp'
      )
      const connection = createConnection(activeFixture)
      await connection.connect()
      try {
        const error = await deployAndLaunchRelay(connection, undefined, 60).catch((e: Error) => e)
        expect(error).toBeInstanceOf(Error)
        const message = (error as Error).message
        console.log(`[offline-node-headers] ${NODE_IMAGE} no-headers: ${message.split('\n')[0]}`)
        expect(message).toContain('no local headers matching its own version')
        expect(message).not.toContain('Orca defect')
        expect(message).toContain('ECONNREFUSED')
      } finally {
        await connection.disconnect()
      }
    }, 600_000)
  }
)
