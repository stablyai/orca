import { app } from 'electron'
import { z } from 'zod'
import { packagedCliEntryPath, getCliLaunchArgs } from './startup/cli-launch-redirect'
import { CLI_COMMAND_NAMES } from './startup/cli-command-names'
import { argvRequestsServeMode } from './startup/serve-mode-argv'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidAppVersion } from '../shared/app-version'
import {
  isShipItRunningForBundle,
  listProcessCommandsSync,
  shipItInstallRequestsForBundle
} from '../shared/shipit-process-listing'

export const MAC_UPDATE_INSTALL_LAUNCH_EXIT_CODE = 75
const MAX_AGE_MS = 10 * 60 * 1000
const ATTEMPT_NAME = /^attempt-(\d+)-[1-9]\d*-[a-f0-9-]{36}\.json(\.tmp)?$/
let ownedAttempt: string | null = null

const installAttemptSchema = z.object({
  schema: z.literal(1),
  execPath: z.string(),
  bundlePath: z.string(),
  sourceVersion: z.string().refine(isValidAppVersion),
  targetVersion: z.string().refine(isValidAppVersion),
  createdAtMs: z.number().int().nonnegative(),
  attemptId: z.string()
})
type InstallAttempt = z.infer<typeof installAttemptSchema>
const nativeBundleUrlSchema = z.string().refine((value) => {
  try {
    fileURLToPath(value)
    return true
  } catch {
    return false
  }
})
const relaunchRequestSchema = z.object({
  launchAfterInstallation: z.literal(true),
  bundleIdentifier: z.string().min(1),
  targetBundleURL: nativeBundleUrlSchema,
  updateBundleURL: nativeBundleUrlSchema
})

function identity(): { execPath: string; bundlePath: string; directory: string } | null {
  const execPath = normalize(process.execPath)
  const bundlePath = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1]
  if (!isAbsolute(execPath) || !bundlePath || realpathSync(execPath) !== execPath) {
    return null
  }
  return {
    execPath,
    bundlePath,
    directory: join(
      app.getPath('appData'),
      'orca-update-install-handoffs',
      createHash('sha256').update(execPath).digest('hex')
    )
  }
}

function removeAttempt(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* Best effort; no shared mutable marker. */
  }
}

// Read regular files only, with a hard allocation bound even if a writer replaces the path.
function readJson(path: string, limit = 4096): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) {
      throw new Error('Invalid record size or type')
    }
    const buffer = Buffer.alloc(limit + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size !== stat.size || size > limit) {
      throw new Error('Incomplete record')
    }
    return JSON.parse(buffer.subarray(0, size).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

function attemptNames(directory: string): string[] {
  const dir = opendirSync(directory)
  try {
    const names: string[] = []
    for (let count = 0; count <= 256; count++) {
      const entry = dir.readSync()
      if (!entry) {
        return names
      }
      if (count === 256) {
        throw new Error('Too many install records')
      }
      if (ATTEMPT_NAME.test(entry.name)) {
        names.push(entry.name)
      }
    }
    return names
  } finally {
    dir.closeSync()
  }
}

function pruneExpired(directory: string, names: string[], now: number): void {
  for (const name of names) {
    const created = Number(ATTEMPT_NAME.exec(name)?.[1])
    if (now - created > MAX_AGE_MS) {
      removeAttempt(join(directory, name))
    }
  }
}

/** Only explicit interactive desktop installs publish; publication failure cannot block installation. */
export function markMacUpdateInstallInFlight(targetVersion: string): void {
  if (process.platform !== 'darwin' || !app.isPackaged || !targetVersion) {
    return
  }
  let temporary: string | null = null
  try {
    const current = identity()
    if (!current) {
      return
    }
    const createdAtMs = Date.now()
    const attemptId = `${createdAtMs}-${process.pid}-${randomUUID()}`
    const record: InstallAttempt = {
      schema: 1,
      execPath: current.execPath,
      bundlePath: current.bundlePath,
      sourceVersion: app.getVersion(),
      targetVersion,
      createdAtMs,
      attemptId
    }
    mkdirSync(current.directory, { recursive: true, mode: 0o700 })
    pruneExpired(current.directory, attemptNames(current.directory), createdAtMs)
    const path = join(current.directory, `attempt-${attemptId}.json`)
    temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
    ownedAttempt = path
  } catch {
    if (temporary) {
      removeAttempt(temporary)
    }
  }
}

/** Reset withdraws only the attempt this process published, synchronously before retry. */
export function clearMacUpdateInstallMarker(): void {
  if (ownedAttempt) {
    removeAttempt(ownedAttempt)
  }
  ownedAttempt = null
}

function requestedRelaunch(listing: string, bundlePath: string): boolean {
  return shipItInstallRequestsForBundle(listing, bundlePath).some(({ label, statePath }) => {
    try {
      // Native staging writes NO; relaunchToInstallUpdate writes YES before terminating the app.
      const request = relaunchRequestSchema.safeParse(readJson(statePath, 64 * 1024)).data
      return (
        !!request &&
        label === `${request.bundleIdentifier}.ShipIt` &&
        normalize(fileURLToPath(request.targetBundleURL)).replace(/\/$/, '') === bundlePath
      )
    } catch {
      return false
    }
  })
}

/** Uncertainty admits startup; only a live exact-bundle installer with native relaunch intent refuses. */
export function shouldExitForInFlightMacUpdateInstall(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return false
  }
  if (process.env.ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE === '1') {
    console.error(
      '[startup] macOS update install launch gate bypassed: ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE=1'
    )
    return false
  }
  try {
    const current = identity()
    if (!current) {
      return false
    }
    const names = attemptNames(current.directory)
    const now = Date.now()
    pruneExpired(current.directory, names, now)
    const relevant: InstallAttempt[] = []
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        continue
      }
      const path = join(current.directory, name)
      let record: InstallAttempt | undefined
      try {
        record = installAttemptSchema.safeParse(readJson(path)).data
      } catch {
        continue
      }
      if (
        !record ||
        name !== `attempt-${record.attemptId}.json` ||
        !record.attemptId.startsWith(`${record.createdAtMs}-`)
      ) {
        continue
      }
      if (record.sourceVersion === record.targetVersion) {
        continue
      }
      const age = now - record.createdAtMs
      if (age < 0 || age > MAX_AGE_MS) {
        continue
      }
      if (record.execPath !== current.execPath || record.bundlePath !== current.bundlePath) {
        continue
      }
      if (record.sourceVersion !== app.getVersion()) {
        removeAttempt(path)
        continue
      }
      relevant.push(record)
    }
    if (!relevant.length) {
      return false
    }
    const listing = listProcessCommandsSync()
    if (listing === null) {
      return false
    }
    if (!shipItInstallRequestsForBundle(listing, current.bundlePath).length) {
      if (!isShipItRunningForBundle(listing, current.bundlePath)) {
        for (const record of relevant) {
          removeAttempt(join(current.directory, `attempt-${record.attemptId}.json`))
        }
      }
      return false
    }
    if (!requestedRelaunch(listing, current.bundlePath)) {
      return false
    }
    const confirmed = listProcessCommandsSync()
    if (confirmed === null || !requestedRelaunch(confirmed, current.bundlePath)) {
      return false
    }
    const record = relevant.find((attempt) => {
      const age = Date.now() - attempt.createdAtMs
      return age >= 0 && age <= MAX_AGE_MS
    })
    if (!record) {
      return false
    }
    console.error(
      `[startup] macOS update install: refusing old desktop launch; source=${record.sourceVersion} target=${record.targetVersion} bundle=${current.bundlePath}; exact ShipIt is live and requested relaunch; exit=${MAC_UPDATE_INSTALL_LAUNCH_EXIT_CODE}; bypass: ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE=1`
    )
    return true
  } catch {
    return false
  }
}

/** Pure launch classification; recovery must inspect raw argv before dispatch or normalization. */
export function isDesktopLaunch(options: {
  argv: string[]
  platform: NodeJS.Platform
  isPackaged: boolean
  resourcesPath: string
}): boolean {
  return (
    !argvRequestsServeMode(options.argv) &&
    getCliLaunchArgs(options.argv, packagedCliEntryPath(options.platform, options.resourcesPath), {
      ...options,
      commandNames: CLI_COMMAND_NAMES
    }) === null
  )
}

/** Refuse only desktop startup; recovery and CLI dispatch still receive the untouched argv. */
export function exitForInFlightMacUpdateInstall(): boolean {
  if (
    process.platform !== 'darwin' ||
    !app.isPackaged ||
    !isDesktopLaunch({
      argv: process.argv,
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }) ||
    !shouldExitForInFlightMacUpdateInstall()
  ) {
    return false
  }
  app.exit(MAC_UPDATE_INSTALL_LAUNCH_EXIT_CODE)
  return true
}
