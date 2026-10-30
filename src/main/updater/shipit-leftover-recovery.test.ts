import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareShipItStaging,
  shipItInstallLockPath,
  shipItStagingOwnersDir,
  type ShipItStagingDeps
} from './shipit-leftover-recovery'

const SHIPIT = '/Applications/Orca Beta.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'

describe('prepareShipItStaging', () => {
  let root: string
  let cacheDir: string
  let coordinationDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-shipit-recovery-'))
    cacheDir = join(root, 'Caches', 'com.stablyai.orca.ShipIt')
    coordinationDir = join(root, 'coordination')
    await mkdir(join(cacheDir, 'update.6rnCgPu', 'Orca.app'), { recursive: true })
    await writeFile(join(cacheDir, 'ShipItState.plist'), '<plist/>')
    await writeFile(join(cacheDir, 'ShipIt_stderr.log'), 'Code=-9 "App Still Running Error"')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const deps = (overrides: Partial<ShipItStagingDeps> = {}): ShipItStagingDeps => ({
    bundleId: 'com.stablyai.orca',
    cacheDir,
    coordinationDir,
    pid: 500,
    isProcessAlive: (pid) => pid === 500,
    listProcesses: vi.fn(async () => '/sbin/launchd\n/usr/bin/login\n'),
    ...overrides
  })

  const leftovers = (): boolean =>
    existsSync(join(cacheDir, 'ShipItState.plist')) || existsSync(join(cacheDir, 'update.6rnCgPu'))

  it('clears a dead install request so Squirrel can stage again, keeping its logs', async () => {
    await expect(prepareShipItStaging(deps())).resolves.toEqual({
      kind: 'recovered',
      removed: ['ShipItState.plist', 'update.6rnCgPu']
    })
    expect(leftovers()).toBe(false)
    expect(existsSync(join(cacheDir, 'ShipIt_stderr.log'))).toBe(true)
    expect(existsSync(shipItInstallLockPath(coordinationDir))).toBe(false)
    expect(await readdir(shipItStagingOwnersDir(coordinationDir))).toEqual(['500'])
  })

  it('leaves the cache alone while another live Orca owns staged state', async () => {
    await mkdir(shipItStagingOwnersDir(coordinationDir), { recursive: true })
    await writeFile(join(shipItStagingOwnersDir(coordinationDir), '600'), '')
    const live = deps({ isProcessAlive: (pid) => pid === 500 || pid === 600 })
    await expect(prepareShipItStaging(live)).resolves.toEqual({
      kind: 'skipped',
      reason: 'owner-live'
    })
    expect(leftovers()).toBe(true)
    // Still recorded: this process is about to stage too.
    expect((await readdir(shipItStagingOwnersDir(coordinationDir))).sort()).toEqual(['500', '600'])

    // Once that owner is gone, its record no longer protects anything.
    await expect(prepareShipItStaging(deps({ pid: 700 }))).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'owner-live'
    })
    await expect(prepareShipItStaging(deps())).resolves.toMatchObject({ kind: 'recovered' })
    expect(await readdir(shipItStagingOwnersDir(coordinationDir))).toEqual(['500'])
  })

  it('ignores the ShipIt of another app', async () => {
    const other = deps({
      listProcesses: async () =>
        '/Applications/Other.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.other.ShipIt /x\n'
    })
    await expect(prepareShipItStaging(other)).resolves.toMatchObject({ kind: 'recovered' })
  })

  it('never clears while ShipIt runs, or when that cannot be checked', async () => {
    const running = deps({ listProcesses: async () => `${SHIPIT} com.stablyai.orca.ShipIt\n` })
    await expect(prepareShipItStaging(running)).resolves.toEqual({
      kind: 'skipped',
      reason: 'installer-running'
    })
    const unknown = deps({ listProcesses: async () => null })
    await expect(prepareShipItStaging(unknown)).resolves.toEqual({
      kind: 'skipped',
      reason: 'installer-unknown'
    })
    expect(leftovers()).toBe(true)
    expect(existsSync(shipItInstallLockPath(coordinationDir))).toBe(false)
  })

  it('takes the install lock: a live holder wins, a dead one is reclaimed', async () => {
    await mkdir(coordinationDir, { recursive: true })
    await writeFile(shipItInstallLockPath(coordinationDir), JSON.stringify({ pid: 600 }))
    const held = deps({ isProcessAlive: (pid) => pid === 500 || pid === 600 })
    await expect(prepareShipItStaging(held)).resolves.toEqual({
      kind: 'skipped',
      reason: 'locked'
    })
    expect(leftovers()).toBe(true)

    await expect(prepareShipItStaging(deps())).resolves.toMatchObject({ kind: 'recovered' })
    expect(existsSync(shipItInstallLockPath(coordinationDir))).toBe(false)
  })

  it('does nothing extra when there is nothing left over', async () => {
    await rm(cacheDir, { recursive: true, force: true })
    const d = deps()
    await expect(prepareShipItStaging(d)).resolves.toEqual({ kind: 'clean' })
    expect(d.listProcesses).not.toHaveBeenCalled()
    expect(await readdir(shipItStagingOwnersDir(coordinationDir))).toEqual(['500'])
  })
})
