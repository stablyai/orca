import { lstatSync, type Stats } from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import {
  buildBrowserDownloadCollisionCandidate,
  MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS,
  normalizeBrowserDownloadFilename
} from '../../../shared/browser-download-filename'

export type BrowserDownloadDestination = {
  filename: string
  savePath: string
  /** This reservation's own token: release() frees the file only while it still holds it. */
  reservationKey: string
}

/** A nested or overwrite destination; replacesFile when an overwrite found a file there. */
export type BrowserDownloadTargetDestination = BrowserDownloadDestination & {
  replacesFile: boolean
}

export type BrowserDownloadReserveOptions = {
  /** Folders under Downloads to save into, created when missing. */
  directories?: readonly string[]
  /** Replace an existing file instead of picking "name (1).ext". */
  overwrite?: boolean
}

type BrowserDownloadDestinationOptions = {
  downloadsPath?: string
  pathExists?: (filePath: string) => boolean
  platform?: NodeJS.Platform
}

/** A '/'-separated path relative to Downloads (Chrome's `filename` rule), or null when unsafe. */
export function splitBrowserDownloadRelativePath(raw: string): string[] | null {
  if (raw.includes('\\') || /^[A-Za-z]:/.test(raw)) {
    return null
  }
  const segments = raw.split('/')
  const safe = segments.every((segment) => !['', '.', '..'].includes(segment.trim()))
  return safe ? segments : null
}

function normalizeReservationKey(filePath: string, platform: NodeJS.Platform): string {
  const resolvedPath = path.resolve(filePath)
  // Why NFC on macOS: APFS treats NFC and NFD spellings of a name as one file.
  const normalizedPath = platform === 'darwin' ? resolvedPath.normalize('NFC') : resolvedPath
  // Use a fixed locale for stable ASCII folding on case-insensitive filesystems.
  return platform === 'win32' || platform === 'darwin'
    ? normalizedPath.toLocaleLowerCase('en-US')
    : normalizedPath
}

/** Why lstat, not existsSync: a dangling symlink is "missing" to existsSync yet would redirect the save. */
function hasEntry(filePath: string): boolean {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

function lstatOrNull(filePath: string): Promise<Stats | null> {
  return lstat(filePath).catch(() => null)
}

/** The real path of the nearest existing folder plus the missing rest, or null when a link there is broken. */
async function realPathOfNearest(target: string): Promise<string | null> {
  const missing: string[] = []
  let existing = path.resolve(target)
  while (!(await lstatOrNull(existing))) {
    const parent = path.dirname(existing)
    if (parent === existing) {
      return path.resolve(target)
    }
    missing.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.join(await realpath(existing), ...missing)
  } catch {
    return null
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * The folder named as its real place under Downloads, so a folder reached through a symlink keys
 * like its real one and a top-level target keys like a plain name.
 */
async function reservationDirectory(downloadsPath: string, directory: string): Promise<string> {
  const root = path.resolve(downloadsPath)
  const realRoot = await realPathOfNearest(root)
  if (realRoot === null) {
    // A broken Downloads link holds nothing to redirect to; creating the folder fails instead.
    return path.resolve(directory)
  }
  const realDirectory = await realPathOfNearest(directory)
  // Why: a symlinked folder under Downloads must not redirect the save outside it.
  if (realDirectory === null || !isInside(realRoot, realDirectory)) {
    throw new Error('The download folder leads outside Downloads.')
  }
  return path.join(root, path.relative(realRoot, realDirectory))
}

/** A token is `<serial>:<path key>`; the key alone names the file. */
function holderPathKey(reservationKey: string): string {
  return reservationKey.slice(reservationKey.indexOf(':') + 1)
}

const RESET_ERROR = 'Downloads were reset while this file was being reserved.'

export class BrowserDownloadDestinationReservations {
  /** File key → the token of the reservation holding it. */
  private readonly holders = new Map<string, string>()
  private nextToken = 0
  /** Why: clear() must also void a reservation still waiting on the disk. */
  private generation = 0
  private readonly pathExists: (filePath: string) => boolean
  private readonly downloadsPath: () => string
  private readonly platform: NodeJS.Platform

  constructor(options: BrowserDownloadDestinationOptions = {}) {
    this.pathExists = options.pathExists ?? hasEntry
    this.downloadsPath = () => options.downloadsPath ?? app.getPath('downloads')
    this.platform = options.platform ?? process.platform
  }

  reserve(filename: string): BrowserDownloadDestination {
    const safeFilename = normalizeBrowserDownloadFilename(filename, this.platform)
    const downloadsPath = this.downloadsPath()

    for (let attempt = 0; attempt < MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateFilename = buildBrowserDownloadCollisionCandidate(safeFilename, attempt)
      const savePath = path.join(downloadsPath, candidateFilename)
      const pathKey = normalizeReservationKey(savePath, this.platform)
      if (this.holders.has(pathKey) || this.pathExists(savePath)) {
        continue
      }
      return {
        filename: candidateFilename,
        savePath,
        reservationKey: this.hold(pathKey)
      }
    }

    throw new Error('Could not choose a unique file name in Downloads.')
  }

  /** chrome.downloads targets: folder checks and creation are async, so the key is re-checked after each wait. */
  async reserveTarget(
    filename: string,
    options: BrowserDownloadReserveOptions = {}
  ): Promise<BrowserDownloadTargetDestination> {
    const generation = this.generation
    const safeFilename = normalizeBrowserDownloadFilename(filename, this.platform)
    const downloadsPath = this.downloadsPath()
    const directories = (options.directories ?? []).map((segment) =>
      normalizeBrowserDownloadFilename(segment, this.platform)
    )
    const directory = path.join(downloadsPath, ...directories)
    const keyDirectory = await reservationDirectory(downloadsPath, directory)
    const keyFor = (name: string) =>
      normalizeReservationKey(path.join(keyDirectory, name), this.platform)

    if (options.overwrite) {
      const savePath = path.join(directory, safeFilename)
      const pathKey = keyFor(safeFilename)
      this.refuseReserved(pathKey)
      const existing = await lstatOrNull(savePath)
      if (existing && !existing.isFile()) {
        throw new Error('Only a regular file in Downloads can be overwritten.')
      }
      // Why again: another save can take the file while lstat runs.
      this.refuseReserved(pathKey)
      const replacesFile = existing !== null
      return this.take(
        { filename: safeFilename, savePath, replacesFile },
        pathKey,
        directory,
        generation
      )
    }

    for (let attempt = 0; attempt < MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateFilename = buildBrowserDownloadCollisionCandidate(safeFilename, attempt)
      const savePath = path.join(directory, candidateFilename)
      const pathKey = keyFor(candidateFilename)
      // Why lstat: a dangling symlink would redirect the save; the second check covers the wait.
      if (this.holders.has(pathKey) || (await lstatOrNull(savePath)) || this.holders.has(pathKey)) {
        continue
      }
      return this.take(
        { filename: candidateFilename, savePath, replacesFile: false },
        pathKey,
        directory,
        generation
      )
    }

    throw new Error('Could not choose a unique file name in Downloads.')
  }

  /** Why the token: after clear(), a stale release must not free a later reservation of the file. */
  release(reservationKey: string | null): void {
    if (reservationKey && this.holds(reservationKey)) {
      this.holders.delete(holderPathKey(reservationKey))
    }
  }

  /** Whether this reservation still holds its file: not once released, cleared or taken over. */
  holds(reservationKey: string | null): boolean {
    return (
      reservationKey !== null && this.holders.get(holderPathKey(reservationKey)) === reservationKey
    )
  }

  clear(): void {
    this.holders.clear()
    this.generation += 1
  }

  private hold(pathKey: string): string {
    this.nextToken += 1
    const token = `${this.nextToken}:${pathKey}`
    this.holders.set(pathKey, token)
    return token
  }

  private refuseReserved(pathKey: string): void {
    if (this.holders.has(pathKey)) {
      throw new Error('Another download is already saving to this file.')
    }
  }

  /** Why the folder last: a refused save must leave no folders behind. */
  private async take(
    destination: Omit<BrowserDownloadTargetDestination, 'reservationKey'>,
    pathKey: string,
    folder: string,
    generation: number
  ): Promise<BrowserDownloadTargetDestination> {
    // Why here: a clear() during any wait above voids this reservation before it holds a file.
    if (this.generation !== generation) {
      throw new Error(RESET_ERROR)
    }
    // Why before the wait: a concurrent reservation must already see the file as taken.
    const reservationKey = this.hold(pathKey)
    try {
      await mkdir(folder, { recursive: true })
    } catch {
      this.release(reservationKey)
      throw new Error('Could not create the download folder.')
    }
    // Why again: after a clear() during mkdir, a later reservation may already hold this file.
    if (this.generation !== generation) {
      throw new Error(RESET_ERROR)
    }
    return { ...destination, reservationKey }
  }
}

export const browserDownloadDestinationReservations = new BrowserDownloadDestinationReservations()
