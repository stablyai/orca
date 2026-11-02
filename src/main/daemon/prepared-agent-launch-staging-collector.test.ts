import './mock-descendant-sweep'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import {
  recordStagedStartupReader,
  stageStartupCommand
} from '../../shared/startup-command-staging'
import type { PreparedLaunchIncarnation } from '../../shared/prepared-agent-launch'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { readCurrentPreparedLaunchIncarnation } from './prepared-agent-launch-incarnation'
import { collectOwnedStartupStaging } from './prepared-agent-launch-staging-collector'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('owned launch staging collection', () => {
  let staging: string
  let daemonDir: string
  let server: DaemonServer | undefined

  beforeEach(() => {
    staging = realpathSync(mkdtempSync(join(tmpdir(), 'orca-owned-staging-test-')))
    daemonDir = mkdtempSync(join(tmpdir(), 'orca-owned-staging-daemon-'))
  })

  afterEach(async () => {
    await server?.shutdown()
    vi.unstubAllEnvs()
    rmSync(staging, { recursive: true, force: true })
    rmSync(daemonDir, { recursive: true, force: true })
  })

  function stage(owner: PreparedLaunchIncarnation) {
    return stageStartupCommand({
      command: `cx '${'x'.repeat(600)}'`,
      shellPath: '/bin/zsh',
      platform: 'darwin',
      directory: staging,
      owned: true,
      owner
    })
  }

  it('collects an earlier boot or a dead writer with no reader at daemon start, without new staging', async () => {
    const boot = await readBootIdentity()
    const exited = spawnSync(process.execPath, ['-e', '']).pid!
    // Crash leftovers: an earlier boot, and a boot-less launch whose daemon died before any shell.
    const earlierBoot = stage({ pid: exited, boot: 'an-earlier-boot' })
    const deadWriterNoReader = stage({ pid: exited })
    // Possibly still read: this boot's launch, a live shell reader, and a live writer.
    const thisBoot = boot ? stage({ pid: process.pid, boot }) : undefined
    const liveReader = stage({ pid: exited })
    recordStagedStartupReader(liveReader, process.pid)
    const liveWriter = stage({ pid: process.pid })
    vi.stubEnv('TMPDIR', staging)

    server = new DaemonServer({
      socketPath: getDaemonSocketPath(daemonDir),
      tokenPath: join(daemonDir, 'test.token'),
      spawnSubprocess: () => {
        throw new Error('collection must not launch anything')
      }
    })
    await server.start()
    // Nothing but the daemon's own start runs the collector here.
    await vi.waitFor(() => expect(existsSync(deadWriterNoReader.directoryPath!)).toBe(false))
    await collectOwnedStartupStaging()

    expect(existsSync(earlierBoot.directoryPath!)).toBe(boot === undefined)
    expect(existsSync(deadWriterNoReader.directoryPath!)).toBe(false)
    for (const kept of [thisBoot, liveReader, liveWriter]) {
      if (kept) {
        expect(existsSync(kept.scriptPath!)).toBe(true)
      }
    }
    expect(readdirSync(staging)).toHaveLength(thisBoot ? 3 : 2)
  })

  it('keeps a live writer first seen without its boot until its start proves it gone', async () => {
    // The writer could not read its boot when it staged; this sweep can, for the same live process.
    const { boot: _unknownThen, ...live } = await readCurrentPreparedLaunchIncarnation()
    const unhandedLive = stage(live)
    // The same PID with a known different start is another process: the writer is gone.
    const reusedPid = stage({ ...live, start: `${live.start}-earlier` })
    await collectOwnedStartupStaging(staging)
    expect(existsSync(unhandedLive.scriptPath!)).toBe(true)
    expect(existsSync(reusedPid.directoryPath!)).toBe(live.start === undefined)
  })
})
