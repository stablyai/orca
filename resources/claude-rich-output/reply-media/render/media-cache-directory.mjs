import { lstatSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// Extraction takes at most two minutes; a bounded clip plays for at most ten.
const ACTIVE_MS = 15 * 60 * 1000
const ENTRY = /^[a-f0-9]{40}(?:\.png)?$/
const TEMPORARY = /^[a-f0-9]{40}\.png\.\d+\.(?:[0-9a-f-]{36}\.png|tmp)$/

function entryBytes(path, stat) {
  if (stat.isFile()) {
    return stat.size
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return 0
  }
  return readdirSync(path).reduce((bytes, name) => {
    const child = join(path, name)
    return bytes + entryBytes(child, lstatSync(child))
  }, 0)
}

function markUsed(path, now) {
  try {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      return
    }
    writeFileSync(`${path}.used`, '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        rmSync(`${path}.used`, { force: true })
      } catch {
        // A failed conversion must not depend on optional usage-marker cleanup.
      }
    }
    if (error.code !== 'EEXIST') {
      return
    }
  }
  try {
    const stat = lstatSync(`${path}.used`)
    if (stat.isFile() && !stat.isSymbolicLink()) {
      utimesSync(`${path}.used`, stat.atime, new Date(now))
    }
  } catch {
    // Usage tracking must not turn a reusable preview into a conversion failure.
  }
}

function lastUsed(path, stat) {
  try {
    const marker = lstatSync(`${path}.used`)
    if (marker.isFile() && !marker.isSymbolicLink()) {
      return Math.max(stat.mtimeMs, marker.mtimeMs)
    }
  } catch {
    // Older cache entries have no usage marker yet.
  }
  return stat.mtimeMs
}

export function pruneMediaCache(directory, keep) {
  const now = Date.now()
  if (keep) {
    markUsed(keep, now)
  }
  let entries
  try {
    entries = readdirSync(directory).flatMap((name) => {
      if (name.endsWith('.used') && ENTRY.test(name.slice(0, -5))) {
        const marker = join(directory, name)
        try {
          lstatSync(marker.slice(0, -5))
        } catch (error) {
          if (error.code === 'ENOENT' && now - lstatSync(marker).mtimeMs >= ACTIVE_MS) {
            rmSync(marker, { force: true })
          }
        }
        return []
      }
      const temporary = TEMPORARY.test(name)
      if (!ENTRY.test(name) && !temporary) {
        return []
      }
      const path = join(directory, name)
      try {
        const stat = lstatSync(path)
        if (
          stat.isSymbolicLink() ||
          (temporary ? !stat.isFile() : !stat.isFile() && !stat.isDirectory())
        ) {
          return []
        }
        return [
          {
            path,
            bytes: entryBytes(path, stat),
            used: path === keep ? now : lastUsed(path, stat),
            temporary
          }
        ]
      } catch {
        // Another renderer may be publishing or removing this entry.
        return []
      }
    })
  } catch {
    return
  }
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  for (const entry of entries.sort((left, right) => left.used - right.used)) {
    if (entry.path === keep || now - entry.used < ACTIVE_MS) {
      continue
    }
    if (!entry.temporary && now - entry.used <= MAX_AGE_MS && bytes <= MAX_BYTES) {
      continue
    }
    try {
      rmSync(entry.path, { recursive: true, force: true })
      rmSync(`${entry.path}.used`, { force: true })
      bytes -= entry.bytes
    } catch {
      // Windows may still have a preview open; a later access retries cleanup.
    }
  }
}

export function privateMediaDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error
    }
  }
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  ) {
    throw new Error(`Unsafe reply-media cache directory: ${directory}`)
  }
  return directory
}

export function mediaCacheDirectory(keep) {
  const directory =
    typeof process.getuid === 'function'
      ? join(tmpdir(), `claude-reply-media-${process.getuid()}`)
      : join(process.env.LOCALAPPDATA || homedir(), 'claude-reply-media')
  privateMediaDirectory(directory)
  pruneMediaCache(
    directory,
    typeof keep === 'string' && ENTRY.test(keep) ? join(directory, keep) : undefined
  )
  return directory
}
