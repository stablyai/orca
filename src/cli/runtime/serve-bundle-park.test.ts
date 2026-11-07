import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acksDir,
  bundleCoordinationDir,
  formatBundleIdentity,
  parkRecordPath,
  supervisorsDir,
  type ServeParkRecord
} from '../../shared/serve-bundle-coordination'
import { openServeBundlePark } from '../../shared/serve-bundle-park'
import { superviseServeService } from './serve-supervised-service'
import { createSupervisedParkWatch } from './serve-supervised-park-watch'

const LABEL = 'com.stablyai.orca.serve.default'

describe('openServeBundlePark', () => {
  let root: string
  let executable: string
  let dir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-bundle-park-'))
    const bundle = join(root, 'Orca.app')
    executable = join(bundle, 'Contents', 'MacOS', 'Orca')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(executable, '')
    await writeFile(join(bundle, 'Contents', 'Info.plist'), 'v1')
    dir = bundleCoordinationDir(realpathSync(bundle), join(root, 'data'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const open = (
    env: NodeJS.ProcessEnv = { XPC_SERVICE_NAME: LABEL },
    platform: NodeJS.Platform = 'darwin'
  ) =>
    openServeBundlePark({
      executable,
      env,
      platform,
      userDataRoot: join(root, 'data')
    })

  async function writeRecord(overrides: Partial<ServeParkRecord> = {}): Promise<void> {
    const record: ServeParkRecord = {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      installerPid: process.pid,
      phase: 'park',
      createdAt: Date.now(),
      parkDeadlineAt: Date.now() + 60_000,
      commitDeadlineAt: null,
      bundleBefore: 'unused',
      supervisorPids: [process.pid],
      ...overrides
    }
    await mkdir(dir, { recursive: true })
    await writeFile(parkRecordPath(dir), JSON.stringify(record))
  }

  it('takes part only under an installed launchd label on macOS', () => {
    expect(open({})).toBeNull()
    expect(open({ XPC_SERVICE_NAME: 'application.com.other' })).toBeNull()
    expect(open({ XPC_SERVICE_NAME: LABEL }, 'linux')).toBeNull()
    expect(open()).not.toBeNull()
  })

  it('registers with its child pid and removes the registration on close', async () => {
    const park = open()!
    park.heartbeat(77)
    const [name] = await readdir(supervisorsDir(dir))
    expect(JSON.parse(await readFile(join(supervisorsDir(dir), name), 'utf8'))).toMatchObject({
      pid: process.pid,
      childPid: 77,
      label: LABEL
    })
    park.unregister()
    await expect(readdir(supervisorsDir(dir))).resolves.toEqual([])
  })

  it('stops the running server for a park, acknowledges after it exits, and never counts it', async () => {
    const park = open()!
    const stop = vi.fn()
    let tick: (() => void) | null = null
    let runs = 0
    let signalStop: (() => void) | null = null
    const result = superviseServeService({
      userDataPath: join(root, 'profile'),
      executable,
      force: false,
      park,
      readInstallEvidence: async () => ({ kind: 'clear' }),
      currentChild: () => ({ pid: 99, stop }),
      setRepeating: (callback) => {
        tick = callback
        return () => {
          tick = null
        }
      },
      setTimer: (callback) => {
        const timer = setTimeout(callback, 1)
        return () => clearTimeout(timer)
      },
      onStopSignal: (listener) => {
        signalStop = listener
        return () => undefined
      },
      log: () => undefined,
      runOnce: async () => {
        runs++
        if (runs > 1) {
          signalStop?.()
          return 0
        }
        await writeRecord()
        tick?.()
        expect(stop).toHaveBeenCalledOnce()
        await expect(readdir(acksDir(dir))).rejects.toThrow()
        return 0
      }
    })
    await vi.waitFor(async () => expect(await readdir(acksDir(dir))).toHaveLength(1))
    await writeRecord({ phase: 'unpark' })
    await expect(result).resolves.toBe(0)
    expect(runs).toBe(2)
    await expect(readdir(join(root, 'profile'))).rejects.toThrow()
  })

  it('stops a server it is not listed for while a park holds, without counting it', async () => {
    const park = open()!
    const watch = createSupervisedParkWatch(park, {
      currentChild: () => ({ pid: 5, stop }),
      setRepeating: (callback) => {
        tick = callback
        return () => undefined
      },
      now: Date.now
    })
    const stop = vi.fn()
    let tick: (() => void) | null = null
    const attempt = await watch.during(async () => {
      await writeRecord({ supervisorPids: [process.pid + 1] })
      tick?.()
      return 0
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(attempt.parked).toBe(true)
    await expect(readdir(acksDir(dir))).rejects.toThrow()
  })

  it('holds while committed until the bundle changes, then releases', async () => {
    const park = open()!
    await writeRecord({ phase: 'commit', commitDeadlineAt: Date.now() + 60_000 })
    const bundleBefore = JSON.parse(await readFile(parkRecordPath(dir), 'utf8')).bundleBefore
    expect(bundleBefore).toBe('unused')
    // 'unused' differs from the real identity, which models a bundle ShipIt already replaced.
    expect(park.holds()).toBe(false)
    const identity = formatBundleIdentity(
      await stat(join(root, 'Orca.app', 'Contents', 'Info.plist'))
    )
    await writeRecord({
      phase: 'commit',
      commitDeadlineAt: Date.now() + 60_000,
      bundleBefore: identity
    })
    expect(park.holds()).toBe(true)
  })
})
