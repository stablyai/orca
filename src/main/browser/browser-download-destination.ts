import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import {
  buildBrowserDownloadCollisionCandidate,
  MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS,
  normalizeBrowserDownloadFilename
} from '../../shared/browser-download-filename'

export type BrowserDownloadDestination = {
  filename: string
  savePath: string
  reservationKey: string
}

type BrowserDownloadDestinationOptions = {
  downloadsPath?: string
  pathExists?: (filePath: string) => boolean
  realpath?: (directory: string) => string
  platform?: NodeJS.Platform
}

function normalizeReservationKey(filePath: string, platform: NodeJS.Platform): string {
  const normalizedPath = path.resolve(filePath)
  // Use a fixed locale for stable ASCII folding on case-insensitive filesystems.
  return platform === 'win32' || platform === 'darwin'
    ? normalizedPath.toLocaleLowerCase('en-US')
    : normalizedPath
}

function destinationExists(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export class BrowserDownloadDestinationReservations {
  private readonly reservedPathKeys = new Set<string>()
  private readonly pathExists: (filePath: string) => boolean
  private readonly downloadsPath: () => string
  private readonly realpath: (directory: string) => string
  private readonly platform: NodeJS.Platform

  constructor(options: BrowserDownloadDestinationOptions = {}) {
    this.pathExists = options.pathExists ?? destinationExists
    this.realpath = options.realpath ?? realpathSync.native
    this.downloadsPath = () => options.downloadsPath ?? app.getPath('downloads')
    this.platform = options.platform ?? process.platform
  }

  private reservationKey(savePath: string): string {
    // Resolve only the parent: the requested leaf need not exist and must not redirect writes.
    const directory = this.realpath(path.dirname(savePath))
    return normalizeReservationKey(path.join(directory, path.basename(savePath)), this.platform)
  }

  reserve(filename: string): BrowserDownloadDestination {
    const safeFilename = normalizeBrowserDownloadFilename(filename, this.platform)
    const downloadsPath = this.downloadsPath()

    for (let attempt = 0; attempt < MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateFilename = buildBrowserDownloadCollisionCandidate(safeFilename, attempt)
      const savePath = path.join(downloadsPath, candidateFilename)
      const reservationKey = this.reservationKey(savePath)
      if (this.reservedPathKeys.has(reservationKey) || this.pathExists(savePath)) {
        continue
      }
      this.reservedPathKeys.add(reservationKey)
      return {
        filename: candidateFilename,
        savePath,
        reservationKey
      }
    }

    throw new Error('Could not choose a unique file name in Downloads.')
  }

  release(reservationKey: string | null): void {
    if (!reservationKey) {
      return
    }
    this.reservedPathKeys.delete(reservationKey)
  }

  reserveRequestedPath(requestedPath: string): BrowserDownloadDestination {
    const savePath = path.resolve(requestedPath)
    mkdirSync(path.dirname(savePath), { recursive: true })
    const reservationKey = this.reservationKey(savePath)
    if (this.reservedPathKeys.has(reservationKey) || this.pathExists(savePath)) {
      throw new Error('The requested download path already exists or is in use.')
    }
    this.reservedPathKeys.add(reservationKey)
    return { filename: path.basename(savePath), savePath, reservationKey }
  }

  clear(): void {
    this.reservedPathKeys.clear()
  }
}

export const browserDownloadDestinationReservations = new BrowserDownloadDestinationReservations()
