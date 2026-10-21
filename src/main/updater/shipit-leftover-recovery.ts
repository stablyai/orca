/**
 * Squirrel.Mac keeps one install request per bundle id in `~/Library/Caches/<id>.ShipIt/`. When
 * ShipIt is cancelled (e.g. "App Still Running", #14732) the request and its staged copy stay,
 * and every later staging stalls behind them until someone deletes them by hand. Before this
 * process stages, it clears them, but only when it alone may: it holds the install lock, no other
 * live Orca has staged anything, and ShipIt is not running.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { isProcessAlive, macCoordinationRoot } from '../../shared/serve-bundle-coordination'
import {
  isShipItRunningForBundleId,
  listProcessCommands
} from '../../shared/shipit-process-listing'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'

export type ShipItStagingDeps = {
  bundleId: string
  cacheDir: string
  coordinationDir: string
  pid: number
  isProcessAlive: (pid: number) => boolean
  listProcesses: () => Promise<string | null>
}

export type ShipItStagingResult =
  | { kind: 'clean' }
  | { kind: 'recovered'; removed: string[] }
  | {
      kind: 'skipped'
      reason: 'locked' | 'owner-live' | 'installer-running' | 'installer-unknown'
    }

const SHIPIT_STATE_FILE = 'ShipItState.plist'
const STAGED_UPDATE_PATTERN = /^update\.[A-Za-z0-9]+$/

export const shipItInstallLockPath = (coordinationDir: string): string =>
  join(coordinationDir, 'install.lock')
/** One empty file per process that staged (or is about to stage) an update in the shared cache. */
export const shipItStagingOwnersDir = (coordinationDir: string): string =>
  join(coordinationDir, 'shipit-staging-owners')

const isPidName = (name: string): boolean => /^[1-9]\d*$/.test(name)

async function leftoverNames(cacheDir: string): Promise<string[]> {
  const names = await readdir(cacheDir).catch(() => [])
  return names.filter((name) => name === SHIPIT_STATE_FILE || STAGED_UPDATE_PATTERN.test(name))
}

/** O_EXCL lock; a holder that died is reclaimed once. Returns null while a live holder has it. */
async function acquireInstallLock(deps: ShipItStagingDeps): Promise<(() => Promise<void>) | null> {
  const path = shipItInstallLockPath(deps.coordinationDir)
  await mkdir(deps.coordinationDir, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: deps.pid }))
      } finally {
        await handle.close()
      }
      return async () => {
        await unlink(path).catch(() => undefined)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    let holder: unknown = null
    try {
      holder = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Unreadable or half-written: its pid cannot be proven alive, so it is stale.
    }
    const holderPid =
      typeof holder === 'object' && holder !== null && 'pid' in holder
        ? Number(holder.pid)
        : Number.NaN
    if (Number.isSafeInteger(holderPid) && holderPid > 0 && deps.isProcessAlive(holderPid)) {
      return null
    }
    await unlink(path).catch(() => undefined)
  }
  return null
}

async function registerOwner(deps: ShipItStagingDeps): Promise<void> {
  const dir = shipItStagingOwnersDir(deps.coordinationDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, String(deps.pid)), '')
}

/** Live owners other than this process; records of dead ones are removed on the way. */
async function otherLiveOwners(deps: ShipItStagingDeps): Promise<number[]> {
  const dir = shipItStagingOwnersDir(deps.coordinationDir)
  const live: number[] = []
  for (const name of await readdir(dir).catch(() => [])) {
    const pid = Number(name)
    if (!isPidName(name) || pid === deps.pid) {
      continue
    }
    if (deps.isProcessAlive(pid)) {
      live.push(pid)
    } else {
      await rm(join(dir, name), { force: true })
    }
  }
  return live
}

/**
 * Run right before this process asks Squirrel to stage. Always records this process as a staging
 * owner, so no other Orca clears what it is about to stage.
 */
export async function prepareShipItStaging(deps: ShipItStagingDeps): Promise<ShipItStagingResult> {
  if ((await leftoverNames(deps.cacheDir)).length === 0) {
    await registerOwner(deps)
    return { kind: 'clean' }
  }
  const release = await acquireInstallLock(deps)
  if (!release) {
    await registerOwner(deps)
    return { kind: 'skipped', reason: 'locked' }
  }
  try {
    const result = await recoverUnderLock(deps)
    await registerOwner(deps)
    return result
  } finally {
    await release()
  }
}

async function recoverUnderLock(deps: ShipItStagingDeps): Promise<ShipItStagingResult> {
  if ((await otherLiveOwners(deps)).length > 0) {
    return { kind: 'skipped', reason: 'owner-live' }
  }
  const listing = await deps.listProcesses()
  if (listing === null) {
    return { kind: 'skipped', reason: 'installer-unknown' }
  }
  // Why by bundle id: the cache is shared by every copy of Orca, and other apps' ShipIt is irrelevant.
  if (isShipItRunningForBundleId(listing, deps.bundleId)) {
    return { kind: 'skipped', reason: 'installer-running' }
  }
  // Why again: an owner may have registered while the process list was read.
  if ((await otherLiveOwners(deps)).length > 0) {
    return { kind: 'skipped', reason: 'owner-live' }
  }
  const removed = (await leftoverNames(deps.cacheDir)).sort()
  for (const name of removed) {
    await rm(join(deps.cacheDir, name), { recursive: true, force: true })
  }
  return { kind: 'recovered', removed }
}

/**
 * This process's staging step, or null when it is not a packaged macOS app (tests, dev, other
 * platforms). Never throws: a failed recovery leaves staging exactly as it was before.
 */
export function prepareThisProcessShipItStaging(): Promise<void> | null {
  if (process.platform !== 'darwin' || !process.execPath.includes('.app/Contents/MacOS/')) {
    return null
  }
  const home = homedir()
  const bundleId = LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId
  return prepareShipItStaging({
    bundleId,
    cacheDir: join(home, 'Library', 'Caches', `${bundleId}.ShipIt`),
    coordinationDir: join(macCoordinationRoot(home), 'bundle-coordination'),
    pid: process.pid,
    isProcessAlive,
    listProcesses: listProcessCommands
  }).then(
    (result) => {
      if (result.kind !== 'clean') {
        recordUpdaterLifecycle('macos_shipit_leftovers', {
          outcome: result.kind,
          detail: result.kind === 'recovered' ? result.removed.join(', ') : result.reason
        })
      }
    },
    (error: unknown) => {
      recordUpdaterLifecycle(
        'macos_shipit_leftovers',
        { outcome: 'failed', detail: error instanceof Error ? error.name : typeof error },
        { level: 'warn', message: 'Could not check leftover macOS update state' }
      )
    }
  )
}
