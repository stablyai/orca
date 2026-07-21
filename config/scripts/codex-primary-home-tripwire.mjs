#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULT_INTERVAL_MS = 250

function entryType(stat) {
  if (stat.isDirectory()) {
    return 'directory'
  }
  if (stat.isFile()) {
    return 'file'
  }
  if (stat.isSymbolicLink()) {
    return 'symlink'
  }
  if (stat.isSocket()) {
    return 'socket'
  }
  return 'other'
}

async function readEntry(absolutePath, relativePath, entries) {
  const stat = await lstat(absolutePath)
  const type = entryType(stat)
  entries.push({
    path: relativePath || '.',
    type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino
  })
  // Why: primary-home symlinks may point at user data outside .codex. The
  // tripwire observes the link itself without traversing its target.
  if (type !== 'directory') {
    return
  }

  const children = await readdir(absolutePath)
  children.sort((left, right) => left.localeCompare(right))
  for (const child of children) {
    await readEntry(
      path.join(absolutePath, child),
      relativePath ? path.join(relativePath, child) : child,
      entries
    )
  }
}

export async function snapshotCodexHome(codexHome) {
  const resolvedHome = path.resolve(codexHome)
  const entries = []
  try {
    await readEntry(resolvedHome, '', entries)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
    entries.push({ path: '.', type: 'missing' })
  }
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  return { codexHome: resolvedHome, digest, entryCount: entries.length, entries }
}

export function describeCodexHomeChange(before, after) {
  if (before.digest === after.digest) {
    return null
  }
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]))
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]))
  const changedPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter(
      (entryPath) =>
        JSON.stringify(beforeByPath.get(entryPath)) !== JSON.stringify(afterByPath.get(entryPath))
    )
    .sort((left, right) => left.localeCompare(right))
  return {
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changedPaths
  }
}

// Why: with the real-home flag ON, system-default spawn sites deliberately
// delete CODEX_HOME so native codex resolves the user's real ~/.codex — and on
// Windows the binary ignores the USERPROFILE sandbox, so its own volatile
// runtime churn (root sqlite/WAL/SHM, tmp/, log/) is designed behavior no env
// sandbox can contain. Everything else — auth.json, config.toml,
// .credentials.json, hooks.json, sessions/, any unknown path — stays a hard
// containment violation.
const DESIGNED_SYSTEM_DEFAULT_VOLATILE_PATTERN =
  /^(?:[^\\/]+\.sqlite(?:-wal|-shm|-journal)?|tmp(?:[\\/].*)?|log(?:[\\/].*)?)$/i

export function classifyCodexHomeTripwireEvent(event) {
  if (event.scanError || !Array.isArray(event.changedPaths)) {
    return 'violation'
  }
  // Why: the root directory's own mtime churns whenever codex adds/removes a
  // direct child (e.g. a WAL file); it carries no information beyond the
  // substantive paths, so it never decides the classification by itself.
  const substantive = event.changedPaths.filter((entryPath) => entryPath !== '.')
  if (substantive.length === 0) {
    return 'designed-system-default'
  }
  return substantive.every((entryPath) => DESIGNED_SYSTEM_DEFAULT_VOLATILE_PATTERN.test(entryPath))
    ? 'designed-system-default'
    : 'violation'
}

export async function startCodexPrimaryHomeTripwire(options = {}) {
  const primaryHome = path.resolve(options.primaryHome ?? os.homedir())
  const codexHome = path.join(primaryHome, '.codex')
  const intervalMs = Math.max(25, Number(options.intervalMs ?? DEFAULT_INTERVAL_MS))
  const initialSnapshot = await snapshotCodexHome(codexHome)
  let currentSnapshot = initialSnapshot
  let timer = null
  let scanInFlight = false
  let stopped = false
  const events = []

  const scan = async () => {
    if (stopped || scanInFlight) {
      return
    }
    scanInFlight = true
    try {
      const nextSnapshot = await snapshotCodexHome(codexHome)
      const change = describeCodexHomeChange(currentSnapshot, nextSnapshot)
      if (change) {
        const event = { detectedAt: new Date().toISOString(), ...change }
        events.push(event)
        currentSnapshot = nextSnapshot
        await options.onChange?.(event)
      }
    } catch (error) {
      const event = {
        detectedAt: new Date().toISOString(),
        scanError: error instanceof Error ? error.message : String(error),
        changedPaths: []
      }
      events.push(event)
      await options.onChange?.(event)
    } finally {
      scanInFlight = false
    }
  }

  timer = setInterval(() => void scan(), intervalMs)
  // Why: this safety monitor must remain active even when it is the CLI's only open handle.
  // Callers explicitly stop it after their validation window closes.
  return {
    codexHome,
    initialSnapshot,
    getStatus: () => ({ clean: events.length === 0, events: [...events] }),
    scan,
    async stop() {
      if (timer) {
        clearInterval(timer)
      }
      while (scanInFlight) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await scan()
      stopped = true
      return { clean: events.length === 0, events: [...events] }
    }
  }
}

function parseArgs(argv) {
  const options = { primaryHome: os.homedir(), intervalMs: DEFAULT_INTERVAL_MS, once: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--primary-home') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('Missing value for --primary-home')
      }
      options.primaryHome = value
      index += 1
    } else if (arg === '--interval-ms') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value < 25) {
        throw new Error('Invalid --interval-ms')
      }
      options.intervalMs = value
      index += 1
    } else if (arg === '--once') {
      options.once = true
    } else if (arg === '--help') {
      console.log(
        'Usage: node config/scripts/codex-primary-home-tripwire.mjs [--primary-home <path>] [--interval-ms <n>] [--once]'
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.once) {
    const snapshot = await snapshotCodexHome(path.join(options.primaryHome, '.codex'))
    console.log(JSON.stringify({ ...snapshot, entries: undefined }, null, 2))
    return
  }

  let failed = false
  const tripwire = await startCodexPrimaryHomeTripwire({
    ...options,
    onChange: (event) => {
      failed = true
      console.error('\u001b[31;1m[CODEX HOME TRIPWIRE] PRIMARY ~/.codex CHANGED\u001b[0m')
      console.error(JSON.stringify(event, null, 2))
    }
  })
  console.log(
    `[CODEX HOME TRIPWIRE] Watching ${tripwire.codexHome}; press Ctrl+C to stop. No file contents are read.`
  )
  const stop = async () => {
    const status = await tripwire.stop()
    console.log(
      `[CODEX HOME TRIPWIRE] ${status.clean ? 'PASS: no changes' : 'FAIL: changes detected'}`
    )
    process.exit(failed || !status.clean ? 2 : 0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
