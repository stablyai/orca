'use strict'

const { appendFile, mkdtemp, realpath, rename, rm, unlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createRequire } = require('node:module')

const { runSshRelayRuntimePtySmoke } = require('./ssh-relay-runtime-pty-smoke.cjs')
const { observeWindowsResourceSettlement } = require('./ssh-relay-runtime-resource-diagnostics.cjs')

const runtimeRoot = process.argv[2]
if (!runtimeRoot) {
  throw new Error('runtime root argument is required')
}
const runtimeRequire = createRequire(join(runtimeRoot, 'relay.js'))
const nodePty = runtimeRequire('node-pty')
const watcher = runtimeRequire('@parcel/watcher')
const TIMEOUT_MS = 15_000

function deadline(label) {
  let timeout
  const promise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT_MS} ms`)), TIMEOUT_MS)
  })
  return { promise, cancel: () => clearTimeout(timeout) }
}

async function waitFor(events, predicate, label) {
  const timer = deadline(label)
  try {
    while (!predicate(events)) {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), timer.promise])
    }
  } catch (error) {
    throw new Error(`${error.message}; observed=${JSON.stringify(events.slice(-20))}`)
  } finally {
    timer.cancel()
  }
}

async function watcherSmoke() {
  const createdDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-watcher-'))
  // Why: macOS FSEvents reports `/private/var` even when tmpdir returned the `/var` symlink.
  const directory = await realpath(createdDirectory)
  const first = join(directory, 'first.txt')
  const second = join(directory, 'renamed.txt')
  const events = []
  let subscription
  try {
    subscription = await watcher.subscribe(directory, (error, batch) => {
      if (error) {
        throw error
      }
      events.push(...batch.map((event) => ({ type: event.type, path: event.path })))
    })
    await writeFile(first, 'created')
    await waitFor(
      events,
      (seen) => seen.some((event) => event.type === 'create' && event.path === first),
      'watcher create'
    )
    await appendFile(first, '-modified')
    await waitFor(
      events,
      (seen) => seen.some((event) => event.type === 'update' && event.path === first),
      'watcher modify'
    )
    await rename(first, second)
    await waitFor(
      events,
      (seen) =>
        seen.some((event) => event.type === 'delete' && event.path === first) &&
        seen.some((event) => event.type === 'create' && event.path === second),
      'watcher rename'
    )
    await unlink(second)
    await waitFor(
      events,
      (seen) => seen.some((event) => event.type === 'delete' && event.path === second),
      'watcher delete'
    )
    return {
      events: events.map((event) => ({ type: event.type, name: event.path.split(/[\\/]/).at(-1) }))
    }
  } finally {
    await subscription?.unsubscribe()
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const started = process.hrtime.bigint()
  const [pty, watched] = await Promise.all([
    runSshRelayRuntimePtySmoke({ nodePty, runtimeRequire, runtimeRoot }),
    watcherSmoke()
  ])
  const resourceSettlement = await observeWindowsResourceSettlement()
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6
  process.stdout.write(
    `${JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, pty, watcher: watched, resourceSettlement, durationMs, rssBytes: process.memoryUsage().rss })}\n`
  )
}

main().catch((error) => {
  process.stderr.write(`Bundled runtime smoke failed: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
