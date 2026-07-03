import { existsSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

const MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS = 1_000
const WINDOWS_RESERVED_FILENAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*'])

export type BrowserDownloadDestination = {
  filename: string
  savePath: string
  reservationKey: string
}

type BrowserDownloadDestinationOptions = {
  downloadsPath?: string
  pathExists?: (filePath: string) => boolean
  platform?: NodeJS.Platform
}

function normalizeFilename(filename: string): string {
  // Normalize separators first so basename strips paths from any platform.
  const normalizedSeparators = filename.replace(/\\/g, '/')
  const rawBasename = path.posix.basename(normalizedSeparators).trim()
  const safeName = [...rawBasename]
    .map((char) => {
      if (char.charCodeAt(0) < 32 || WINDOWS_RESERVED_FILENAME_CHARS.has(char)) {
        return '_'
      }
      return char
    })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  return safeName || 'download'
}

function buildCollisionCandidate(filename: string, suffix: number): string {
  if (suffix === 0) {
    return filename
  }
  const extension = path.extname(filename)
  const stem = extension ? filename.slice(0, -extension.length) : filename
  return `${stem} (${suffix})${extension}`
}

function normalizeReservationKey(filePath: string, platform: NodeJS.Platform): string {
  const normalizedPath = path.resolve(filePath)
  // Use a fixed locale for stable ASCII folding on case-insensitive filesystems.
  return platform === 'win32' || platform === 'darwin'
    ? normalizedPath.toLocaleLowerCase('en-US')
    : normalizedPath
}

export class BrowserDownloadDestinationReservations {
  private readonly reservedPathKeys = new Set<string>()
  private readonly pathExists: (filePath: string) => boolean
  private readonly downloadsPath: () => string
  private readonly platform: NodeJS.Platform

  constructor(options: BrowserDownloadDestinationOptions = {}) {
    this.pathExists = options.pathExists ?? existsSync
    this.downloadsPath = () => options.downloadsPath ?? app.getPath('downloads')
    this.platform = options.platform ?? process.platform
  }

  reserve(filename: string): BrowserDownloadDestination {
    const safeFilename = normalizeFilename(filename)
    const downloadsPath = this.downloadsPath()

    for (let attempt = 0; attempt < MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateFilename = buildCollisionCandidate(safeFilename, attempt)
      const savePath = path.join(downloadsPath, candidateFilename)
      const reservationKey = normalizeReservationKey(savePath, this.platform)
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

  clear(): void {
    this.reservedPathKeys.clear()
  }
}

export const browserDownloadDestinationReservations = new BrowserDownloadDestinationReservations()
