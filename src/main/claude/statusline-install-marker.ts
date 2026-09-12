import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs'

export type StatusLineInstallMarker = { present: boolean; commandSha256?: string }
export const STATUSLINE_MARKER_MAX_BYTES = 1024

export function statusLineCommandSha256(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

export function readStatusLineInstallMarker(path: string): StatusLineInstallMarker {
  let fd: number
  let observed = false
  try {
    // Nonregular paths retain opt-out without opening a pipe or following a link.
    if (!lstatSync(path).isFile()) {
      return { present: true }
    }
    observed = true
    fd = openSync(path, 'r')
  } catch (error) {
    return { present: observed || (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0 || stat.size > STATUSLINE_MARKER_MAX_BYTES) {
      return { present: true }
    }
    const buffer = Buffer.alloc(STATUSLINE_MARKER_MAX_BYTES)
    let length = 0
    while (length < stat.size) {
      const count = readSync(fd, buffer, {
        offset: length,
        length: stat.size - length,
        position: length
      })
      if (count === 0) {
        return { present: true }
      }
      length += count
    }
    // A growing marker must not be accepted as a valid JSON prefix.
    if (fstatSync(fd).size !== length) {
      return { present: true }
    }
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      'version' in value &&
      value.version === 1 &&
      'commandSha256' in value &&
      typeof value.commandSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.commandSha256)
    ) {
      return { present: true, commandSha256: value.commandSha256 }
    }
  } catch {
    // Unknown metadata retains opt-out history without granting ownership.
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Cleanup failure must not turn uncertain metadata into an install failure.
    }
  }
  return { present: true }
}

export function writeStatusLineInstallMarker(path: string, command: string): void {
  try {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, commandSha256: statusLineCommandSha256(command) })
    )
  } catch {
    // Settings already persisted; exact generated recognition permits a later retry.
  }
}
