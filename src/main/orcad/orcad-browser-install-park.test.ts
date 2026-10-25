import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as flush } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundleCoordinationDir,
  ORCAD_BROWSER_PARK_LABEL,
  supervisorsDir
} from '../../shared/serve-bundle-coordination'
import { openServeBundlePark } from '../../shared/serve-bundle-park'
import {
  commitServeSupervisorPark,
  parkServeSupervisorsForInstall,
  releaseServeSupervisorPark
} from '../updater/serve-supervisor-install-park'
import { watchOrcadBrowserInstallPark } from './orcad-browser-install-park'

const HELPER = 424242

describe('orcad browser helper in the desktop install park', () => {
  let root: string
  let bundle: string
  let executable: string
  let tick: () => void
  let running: boolean
  let starts: AbortSignal[]
  let failStarts: number
  let hangStarts: boolean
  let clock: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orcad-browser-park-'))
    bundle = join(root, 'Orca.app')
    executable = join(bundle, 'Contents', 'MacOS', 'Orca')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(executable, '')
    await writeFile(join(bundle, 'Contents', 'Info.plist'), 'v1')
    tick = () => undefined
    running = true
    starts = []
    failStarts = 0
    hangStarts = false
    clock = 1_000
  })

  afterEach(async () => {
    await releaseServeSupervisorPark()
    await rm(root, { recursive: true, force: true })
  })

  function watch() {
    const park = openServeBundlePark({
      executable,
      label: ORCAD_BROWSER_PARK_LABEL,
      platform: 'darwin',
      env: {},
      userDataRoot: join(root, 'data')
    })
    expect(park).not.toBeNull()
    return watchOrcadBrowserInstallPark(
      {
        pid: () => (running ? HELPER : null),
        stop: async () => {
          running = false
        },
        start: async (signal) => {
          starts.push(signal)
          if (hangStarts) {
            // A starting helper already runs and blocks the install.
            running = true
            await new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error('aborted')))
            )
          }
          if (failStarts > 0) {
            failStarts--
            throw new Error('helper did not become ready')
          }
          running = true
        }
      },
      {
        park: park!,
        now: () => clock,
        log: () => undefined,
        setRepeating: (callback) => {
          tick = callback
          return () => {
            tick = () => undefined
          }
        }
      }
    )
  }

  async function step(): Promise<void> {
    tick()
    await flush()
    await flush()
  }

  const installerDeps = () => ({
    macUserDataRoot: join(root, 'data'),
    listBlockers: async () => (running ? [HELPER] : []),
    sleep: step
  })

  it('stops the helper for an install and starts it again from the replaced bundle', async () => {
    const parkWatch = watch()
    // Unregistered on main: the installer refused a live orcad's helper with no way out.
    await expect(
      parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    ).resolves.toEqual({ kind: 'parked' })
    expect(running).toBe(false)

    await commitServeSupervisorPark(async () => (running ? [HELPER] : []))
    await step()
    expect(running).toBe(false)

    // Mid-swap the bundle is briefly absent: still held.
    await rm(join(bundle, 'Contents', 'Info.plist'))
    await step()
    expect(starts).toHaveLength(0)

    // ShipIt swapped the bundle: the hold ends and the helper runs from the new app.
    await writeFile(join(bundle, 'Contents', 'Info.plist'), 'v2-new-bundle')
    await step()
    expect(running).toBe(true)
    expect(starts).toHaveLength(1)
    await parkWatch.close()
  })

  it('restarts the helper at once when the install is abandoned', async () => {
    const parkWatch = watch()
    await expect(
      parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    ).resolves.toEqual({ kind: 'parked' })
    await releaseServeSupervisorPark()
    await step()
    expect(running).toBe(true)
    await parkWatch.close()
  })

  it('retries a failed restart with backoff instead of leaving the browser off', async () => {
    const parkWatch = watch()
    await parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    await releaseServeSupervisorPark()
    failStarts = 1
    await step()
    expect(starts).toHaveLength(1)
    expect(running).toBe(false)
    await step()
    expect(starts).toHaveLength(1)
    clock += 5_000
    await step()
    expect(starts).toHaveLength(2)
    expect(running).toBe(true)
    await parkWatch.close()
  })

  it('gives up a slow restart so a new install can still park the helper', async () => {
    const parkWatch = watch()
    await parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    await releaseServeSupervisorPark()
    hangStarts = true
    await step()
    // The next heartbeat names the starting helper.
    await step()
    expect(starts).toHaveLength(1)
    await expect(
      parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    ).resolves.toEqual({ kind: 'parked' })
    expect(starts[0]?.aborted).toBe(true)
    await parkWatch.close()
  })

  it('unregisters on close and aborts a restart in flight', async () => {
    const parkWatch = watch()
    const dir = bundleCoordinationDir(realpathSync(bundle), join(root, 'data'))
    expect(await readdir(supervisorsDir(dir))).toHaveLength(1)
    await parkServeSupervisorsForInstall(executable, [HELPER], installerDeps())
    await releaseServeSupervisorPark()
    tick()
    await parkWatch.close()
    expect(starts[0]?.aborted).toBe(true)
    expect(await readdir(supervisorsDir(dir))).toEqual([])
  })
})
