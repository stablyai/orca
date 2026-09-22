import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { listRelayBaseDirsCommand } from './ssh-remote-commands'
import { gcOldRelayVersions } from './ssh-relay-versioned-install'
import type { SshTarget } from '../../shared/ssh-types'

const RUN_REVIEW_ORACLE = process.env.ORCA_REVIEW_SSH_UPLOAD_CANCEL === '1'
const REMOTE_REPO = '/tmp/orca-pr-10207-real-repo'

type TargetFixture = {
  containerName: string
  identityFile: string
  port: number
  tempDir: string
}

type RemoteInventory = {
  installLock: boolean
  payloadFiles: number
  uploadStages: string[]
}

function run(command: string, args: string[], timeout = 30_000): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  }).trim()
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function dockerExec(fixture: TargetFixture, command: string): string {
  return run('docker', ['exec', fixture.containerName, 'bash', '-lc', command], 60_000)
}

function startTarget(): TargetFixture {
  const image = process.env.ORCA_REVIEW_SSH_IMAGE
  if (!image) {
    throw new Error('ORCA_REVIEW_SSH_IMAGE is required')
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-pr10207-ssh-'))
  const identityFile = join(tempDir, 'id_ed25519')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-q'])
  const publicKey = readFileSync(`${identityFile}.pub`, 'utf8').trim()
  const containerName = `orca-pr10207-${randomUUID().slice(0, 12)}`
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
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
  const fixture = { containerName, identityFile, port, tempDir }
  dockerExec(
    fixture,
    [
      `mkdir -p ${shellQuote(REMOTE_REPO)}`,
      `cd ${shellQuote(REMOTE_REPO)}`,
      'git init',
      'git config user.email review@test.local',
      'git config user.name "PR 10207 Review"',
      "printf '%s\\n' real-docker-ssh-repository > README.md",
      'git add README.md',
      'git commit -m initial'
    ].join(' && ')
  )
  return fixture
}

function stopTarget(fixture: TargetFixture | null): void {
  if (!fixture) {
    return
  }
  spawnSync('docker', ['stop', fixture.containerName], { stdio: 'ignore', timeout: 20_000 })
  spawnSync('docker', ['rm', fixture.containerName], { stdio: 'ignore', timeout: 20_000 })
  rmSync(fixture.tempDir, { recursive: true, force: true })
}

function createConnection(fixture: TargetFixture): SshConnection {
  const host = process.env.ORCA_REVIEW_SSH_TARGET_HOST ?? ''
  if (!host || host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    throw new Error(`Review SSH target must be non-loopback, received ${JSON.stringify(host)}`)
  }
  const target: SshTarget = {
    id: `pr-10207-${randomUUID()}`,
    label: 'PR 10207 Docker SSH target',
    source: 'manual',
    host,
    port: fixture.port,
    username: 'root',
    identityFile: fixture.identityFile,
    identitiesOnly: true
  }
  return new SshConnection(target, { onStateChange: vi.fn() })
}

function readInventory(fixture: TargetFixture, remoteRelayDir: string): RemoteInventory {
  const stagePool = '/root/.orca-remote/.upload-stages'
  const raw = dockerExec(
    fixture,
    [
      `lock=0; test -d ${shellQuote(`${remoteRelayDir}/.install-lock`)} && lock=1`,
      `files=0; test -d ${shellQuote(remoteRelayDir)} && files=$(find ${shellQuote(remoteRelayDir)} -type f ! -path '*/.install-lock/*' | wc -l | tr -d ' ')`,
      `printf 'LOCK=%s\\nFILES=%s\\n' "$lock" "$files"`,
      `find ${shellQuote(stagePool)} -mindepth 1 -maxdepth 1 \\( -name 'slot-*' -o -name 'claim-*' -o -name 'delete-*' \\) -print 2>/dev/null | sort || true`
    ].join('; ')
  )
  const lines = raw.split(/\r?\n/)
  return {
    installLock: lines[0] === 'LOCK=1',
    payloadFiles: Number(lines[1]?.slice('FILES='.length) ?? 0),
    uploadStages: lines.slice(2).filter(Boolean)
  }
}

describe.skipIf(!RUN_REVIEW_ORACLE)('SSH relay upload cancellation recovery', () => {
  let fixture: TargetFixture | null = null

  beforeAll(() => {
    fixture = startTarget()
  })

  afterAll(() => {
    stopTarget(fixture)
  })

  it('recovers a post-promotion install lock from a previous execution-host boot', async () => {
    const activeFixture = fixture as TargetFixture
    const remoteRelayDir = '/root/.orca-remote/relay-reboot-lock-oracle'
    const previousBootId = 'linux:00000000-0000-0000-0000-000000000000:0'
    dockerExec(
      activeFixture,
      [
        `rm -rf ${shellQuote(remoteRelayDir)}`,
        `mkdir -p ${shellQuote(`${remoteRelayDir}/.install-lock`)} ${shellQuote(`${remoteRelayDir}/node_modules`)}`,
        `printf '%s\\n' promoted > ${shellQuote(`${remoteRelayDir}/relay.js`)}`,
        `printf '%s\\n' ${shellQuote(previousBootId)} > ${shellQuote(`${remoteRelayDir}/.install-lock/.boot-id`)}`
      ].join(' && ')
    )
    const connection = createConnection(activeFixture)
    await connection.connect()
    try {
      const startedAt = Date.now()
      await acquireInstallLock(connection, remoteRelayDir, getRemoteHostPlatform('linux-arm64'))
      const elapsedMs = Date.now() - startedAt
      const state = dockerExec(
        activeFixture,
        [
          `cat ${shellQuote(`${remoteRelayDir}/.install-lock/.boot-id`)}`,
          `cat ${shellQuote(`${remoteRelayDir}/relay.js`)}`,
          `find ${shellQuote(remoteRelayDir)} -maxdepth 1 -name '.install-lock.tombstone.*' -print | wc -l | tr -d ' '`
        ].join('; ')
      ).split(/\r?\n/u)

      expect(elapsedMs).toBeLessThan(10_000)
      expect(state[0]).toMatch(/^linux:[0-9a-f-]+:[0-9]+$/u)
      expect(state[0]).not.toBe(previousBootId)
      expect(state[1]).toBe('promoted')
      expect(state[2]).toBe('0')
    } finally {
      await connection.disconnect()
      dockerExec(activeFixture, `rm -rf ${shellQuote(remoteRelayDir)}`)
    }
  }, 60_000)

  it('aborts a live SFTP upload after remote bytes arrive without creating the shared lock', async () => {
    const activeFixture = fixture as TargetFixture
    const localRelayDir = join(process.cwd(), 'out', 'relay', 'linux-arm64')
    const relayVersion = readFileSync(join(localRelayDir, '.version'), 'utf8').trim()
    const relayJsSize = statSync(join(localRelayDir, 'relay.js')).size
    const remoteRelayDir = `/root/.orca-remote/relay-${relayVersion}`
    const connection = createConnection(activeFixture)
    await connection.connect()
    const sentinelPid = dockerExec(activeFixture, 'sleep 300 </dev/null >/dev/null 2>&1 & echo $!')
    let releaseFirstWrite: () => void = () => {}
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let acknowledgedBytes = 0
    const openSftp = connection.sftp.bind(connection)
    connection.sftp = vi.fn(async (signal) => {
      const sftp = await openSftp(signal)
      const createWriteStream = sftp.createWriteStream.bind(sftp)
      sftp.createWriteStream = ((...args: Parameters<typeof createWriteStream>) => {
        const [remotePath] = args
        const stream = createWriteStream(...args)
        if (!remotePath.endsWith('/payload/relay.js')) {
          return stream
        }
        const writable = stream as typeof stream & {
          _write: (
            chunk: Buffer,
            encoding: BufferEncoding,
            callback: (error?: Error | null) => void
          ) => void
        }
        const write = writable._write.bind(writable)
        writable._write = (chunk, encoding, callback): void => {
          write(chunk, encoding, (error) => {
            if (error) {
              callback(error)
              return
            }
            acknowledgedBytes += chunk.length
            releaseFirstWrite()
          })
        }
        return stream
      }) as typeof sftp.createWriteStream
      return sftp
    })

    const deployment = deployAndLaunchRelay(connection, undefined, 60)
    let barrierTimeout: ReturnType<typeof setTimeout>
    try {
      await Promise.race([
        firstWrite,
        new Promise<never>((_resolve, reject) => {
          barrierTimeout = setTimeout(
            () => reject(new Error('Timed out waiting for first remote SFTP chunk')),
            30_000
          )
        })
      ])
    } finally {
      clearTimeout(barrierTimeout!)
    }
    const partialRemoteBytes = Number(
      dockerExec(
        activeFixture,
        "find /root/.orca-remote/.upload-stages -type f -path '*/slot-*/payload/relay.js' -printf '%s\\n'"
      )
    )
    const operationController = (
      connection as unknown as { systemOperationAbortController: AbortController }
    ).systemOperationAbortController
    operationController.abort()

    await expect(deployment).rejects.toMatchObject({ name: 'AbortError' })
    const inventory = readInventory(activeFixture, remoteRelayDir)
    const sentinelCommand = dockerExec(
      activeFixture,
      `tr '\\0' ' ' < /proc/${shellQuote(sentinelPid)}/cmdline`
    )
    await connection.disconnect()

    console.log(
      `[pr-10207-live-sftp-abort] ${JSON.stringify({ acknowledgedBytes, partialRemoteBytes, relayJsSize, inventory, sentinelPid, sentinelCommand })}`
    )
    expect(acknowledgedBytes).toBeGreaterThan(0)
    expect(partialRemoteBytes).toBe(acknowledgedBytes)
    expect(partialRemoteBytes).toBeLessThan(relayJsSize)
    expect(inventory.installLock).toBe(false)
    expect(sentinelCommand).toContain('sleep 300')
  }, 180_000)

  it('recovers cancellation with bounded safe reclamation and bounded real version GC', async () => {
    const activeFixture = fixture as TargetFixture
    const relayVersion = readFileSync(
      join(process.cwd(), 'out', 'relay', 'linux-arm64', '.version'),
      'utf8'
    ).trim()
    const remoteRelayDir = `/root/.orca-remote/relay-${relayVersion}`
    const firstConnection = createConnection(activeFixture)
    const progress: string[] = []
    await firstConnection.connect()
    const unconfirmedCancellation = Object.assign(new Error('injected upload cancellation'), {
      sshChannelCloseConfirmed: false
    })
    firstConnection.uploadDirectory = vi.fn().mockRejectedValue(unconfirmedCancellation)

    await expect(
      deployAndLaunchRelay(firstConnection, (status) => progress.push(status), 60)
    ).rejects.toBe(unconfirmedCancellation)
    await firstConnection.disconnect()
    const firstInventory = readInventory(activeFixture, remoteRelayDir)
    const expected = process.env.ORCA_REVIEW_EXPECT_RECOVERY === '1' ? 'recovered' : 'blocked'
    if (expected === 'recovered') {
      const secondAbandonedConnection = createConnection(activeFixture)
      await secondAbandonedConnection.connect()
      secondAbandonedConnection.uploadDirectory = vi.fn().mockRejectedValue(unconfirmedCancellation)
      await expect(deployAndLaunchRelay(secondAbandonedConnection, undefined, 60)).rejects.toBe(
        unconfirmedCancellation
      )
      await secondAbandonedConnection.disconnect()
    }

    const retryConnection = createConnection(activeFixture)
    await retryConnection.connect()
    let retryResult: 'blocked' | 'recovered'
    let finalInventory: RemoteInventory | undefined
    let scaleEvidence:
      | { gcDurationMs: number; listingBytes: number; scaleEntries: number }
      | undefined
    if (firstInventory.installLock) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_500)
      await expect(
        acquireInstallLock(retryConnection, remoteRelayDir, getRemoteHostPlatform('linux-arm64'), {
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      clearTimeout(timer)
      retryResult = 'blocked'
    } else {
      const deployed = await deployAndLaunchRelay(retryConnection, undefined, 60)
      const mux = new SshChannelMultiplexer(deployed.transport)
      await expect(mux.request('session.resolveHome', { path: '~' })).resolves.toEqual({
        resolvedPath: '/root'
      })
      mux.dispose()
      retryResult = 'recovered'
    }
    const repoHead = await execCommand(
      retryConnection,
      `cd ${shellQuote(REMOTE_REPO)} && git rev-parse --verify HEAD`
    )
    await retryConnection.disconnect()

    if (expected === 'recovered') {
      const replacedStage = firstInventory.uploadStages[0]!
      const originalStage = `${replacedStage}.original`
      const foreignTarget = '/root/orca-pr10207-foreign-stage-target'
      const stagePool = '/root/.orca-remote/.upload-stages'
      const symlinkStage = `${stagePool}/slot-2`
      const ownerMarker = '.orca-upload-owner'
      const identityMarker = '.orca-upload-identity'
      dockerExec(
        activeFixture,
        [
          `mv ${shellQuote(replacedStage)} ${shellQuote(originalStage)}`,
          `mkdir -p ${shellQuote(`${replacedStage}/payload`)} ${shellQuote(foreignTarget)}`,
          `cp ${shellQuote(`${originalStage}/${ownerMarker}`)} ${shellQuote(`${replacedStage}/${ownerMarker}`)}`,
          `cp ${shellQuote(`${originalStage}/${identityMarker}`)} ${shellQuote(`${replacedStage}/${identityMarker}`)}`,
          `touch -d '3 hours ago' ${shellQuote(`${replacedStage}/${ownerMarker}`)} ${shellQuote(`${originalStage}/${ownerMarker}`)}`,
          `printf foreign > ${shellQuote(`${replacedStage}/payload/foreign`)}`,
          `printf alive > ${shellQuote(`${foreignTarget}/sentinel`)}`,
          `ln -s ${shellQuote(foreignTarget)} ${shellQuote(symlinkStage)}`,
          `i=0; while [ "$i" -lt 15197 ]; do mkdir ${shellQuote(`/root/.orca-remote/relay-${relayVersion}.upload-scale-`)}"$i"; i=$((i + 1)); done`
        ].join(' && ')
      )
      const adversarialInventory = readInventory(activeFixture, remoteRelayDir)

      const reclaimableStage = `${stagePool}/slot-1`
      dockerExec(
        activeFixture,
        `touch -d '3 hours ago' ${shellQuote(`${reclaimableStage}/${ownerMarker}`)}`
      )

      const cleanupConnection = createConnection(activeFixture)
      await cleanupConnection.connect()
      const cleanedDeployment = await deployAndLaunchRelay(cleanupConnection, undefined, 60)
      const cleanupMux = new SshChannelMultiplexer(cleanedDeployment.transport)
      await expect(cleanupMux.request('session.resolveHome', { path: '~' })).resolves.toEqual({
        resolvedPath: '/root'
      })
      const reclaimDeadline = Date.now() + 10_000
      while (
        dockerExec(
          activeFixture,
          `test -e ${shellQuote(reclaimableStage)} && echo PRESENT || true`
        ) &&
        Date.now() < reclaimDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(
        dockerExec(activeFixture, `test ! -e ${shellQuote(reclaimableStage)} && echo RECLAIMED`)
      ).toBe('RECLAIMED')

      const listing = await execCommand(
        cleanupConnection,
        listRelayBaseDirsCommand(getRemoteHostPlatform('linux-arm64'), '/root/.orca-remote')
      )
      const gcStartedAt = Date.now()
      await gcOldRelayVersions(
        cleanupConnection,
        '/root',
        remoteRelayDir,
        getRemoteHostPlatform('linux-arm64')
      )
      const gcDurationMs = Date.now() - gcStartedAt
      finalInventory = readInventory(activeFixture, remoteRelayDir)
      expect(
        dockerExec(
          activeFixture,
          `test -L ${shellQuote(symlinkStage)} && test -d ${shellQuote(foreignTarget)} && test "$(cat ${shellQuote(`${foreignTarget}/sentinel`)})" = alive && echo PRESERVED`
        ).trim()
      ).toBe('PRESERVED')
      expect(
        dockerExec(
          activeFixture,
          `test -d ${shellQuote(replacedStage)} && test -d ${shellQuote(originalStage)} && echo PRESERVED`
        ).trim()
      ).toBe('PRESERVED')
      expect(finalInventory.uploadStages.sort()).toEqual(
        adversarialInventory.uploadStages.filter((stage) => stage !== reclaimableStage).sort()
      )
      const listingBytes = Buffer.byteLength(listing)
      expect(listingBytes).toBeLessThan(1_024)
      expect(gcDurationMs).toBeLessThan(10_000)
      const scaleEntries = Number(
        dockerExec(
          activeFixture,
          `find /root/.orca-remote -mindepth 1 -maxdepth 1 -type d -name ${shellQuote(`relay-${relayVersion}.upload-scale-*`)} | wc -l`
        )
      )
      expect(scaleEntries).toBe(15_197)
      scaleEvidence = { gcDurationMs, listingBytes, scaleEntries }
      cleanupMux.dispose()
      await cleanupConnection.disconnect()
    }
    console.log(
      `[pr-10207-oracle] ${JSON.stringify({ progress, firstInventory, retryResult, finalInventory, scaleEvidence, repoHead: repoHead.trim() })}`
    )
    expect(progress).toContain('Uploading relay...')
    expect(repoHead.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(retryResult).toBe(expected)
    if (expected === 'recovered') {
      expect(firstInventory.installLock).toBe(false)
      expect(firstInventory.uploadStages.length).toBeGreaterThan(0)
      expect(finalInventory?.installLock).toBe(false)
      expect(finalInventory!.uploadStages).toEqual([
        '/root/.orca-remote/.upload-stages/slot-0',
        '/root/.orca-remote/.upload-stages/slot-0.original',
        '/root/.orca-remote/.upload-stages/slot-2'
      ])
    } else {
      expect(firstInventory.installLock).toBe(true)
      expect(firstInventory.payloadFiles).toBe(0)
    }
  }, 180_000)
})
