import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertPackagedDaemonEntryExists,
  runTerminalHostRoundTrip,
  verifyPackagedDaemonEntryBoots
} = require('./verify-packaged-daemon-entry.cjs')

describe('verify-packaged-daemon-entry', () => {
  let resourcesDir

  beforeEach(() => {
    resourcesDir = mkdtempSync(join(tmpdir(), 'orca-daemon-entry-verify-'))
  })

  afterEach(() => {
    rmSync(resourcesDir, { recursive: true, force: true })
  })

  function writePackagedEntry(source) {
    const entryDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'daemon-entry.js'), source)
  }

  // Why: a silent skip on a missing entry false-passed exactly the packaged
  // layout regression this gate exists to catch (rc.1 daemon-load incident).
  it('throws when the unpacked daemon entry is missing', () => {
    expect(() => assertPackagedDaemonEntryExists(resourcesDir)).toThrow(
      /missing unpacked daemon entry/
    )
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /missing unpacked daemon entry/
    )
  })

  it('passes when the packaged entry loads and reaches argv parsing', () => {
    writePackagedEntry('console.error("Usage: daemon-entry <socket>"); process.exit(1)\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).not.toThrow()
  })

  it('fails when the packaged entry cannot resolve its module graph', () => {
    writePackagedEntry('require("orca-module-that-does-not-exist")\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /failed to load under plain Node/
    )
  })

  it('fails when the packaged entry never reaches argv parsing', () => {
    writePackagedEntry('process.exit(0)\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(/did not reach argv parsing/)
  })
})

describe.skipIf(process.platform === 'win32')('terminal host round trip', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vpd-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // Listens, publishes its token, records its pid, then treats each connection with `onConnection`.
  function fakeDaemon(onConnection) {
    const entry = join(root, 'daemon.cjs')
    writeFileSync(
      entry,
      [
        "const net = require('node:net'), fs = require('node:fs')",
        'const arg = (name) => process.argv[process.argv.indexOf(name) + 1]',
        `fs.writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid))`,
        `net.createServer(${onConnection}).listen(arg('--socket'), () => fs.writeFileSync(arg('--token'), 'tok'))`
      ].join('\n')
    )
    return entry
  }

  async function roundTrip(entry, timeoutMs) {
    const startedAt = Date.now()
    const error = await runTerminalHostRoundTrip({
      command: [process.execPath],
      entry,
      deadline: startedAt + timeoutMs,
      stderr: [],
      scratchPrefix: join(root, 'oth-')
    }).then(
      () => null,
      (rejection) => rejection
    )
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'))
    let daemonAlive = true
    try {
      process.kill(pid, 0)
    } catch {
      daemonAlive = false
    }
    return {
      error,
      elapsedMs: Date.now() - startedAt,
      daemonAlive,
      scratchDirs: readdirSync(root).filter((name) => name.startsWith('oth-'))
    }
  }

  it('rejects by the deadline and cleans up when the daemon never answers the hello', async () => {
    const result = await roundTrip(fakeDaemon('() => {}'), 1_500)
    expect(result.error?.message).toMatch(/timed out waiting for the control hello reply/)
    expect(result.elapsedMs).toBeLessThan(1_500 + 5_000)
    expect(result.daemonAlive).toBe(false)
    expect(result.scratchDirs).toEqual([])
  })

  it('rejects at once and cleans up when the daemon closes the connection', async () => {
    const result = await roundTrip(fakeDaemon('(socket) => socket.destroy()'), 10_000)
    // A destroyed socket with unread input may surface as a reset instead of a clean close.
    expect(result.error?.message).toMatch(/closed the control connection|ECONNRESET/)
    expect(result.elapsedMs).toBeLessThan(10_000)
    expect(result.daemonAlive).toBe(false)
    expect(result.scratchDirs).toEqual([])
  })

  it('rejects and cleans up when the daemon replies with malformed JSON', async () => {
    const result = await roundTrip(fakeDaemon("(socket) => socket.write('{not json\\n')"), 10_000)
    expect(result.error?.message).toMatch(/non-JSON control line: \{not json/)
    expect(result.elapsedMs).toBeLessThan(10_000)
    expect(result.daemonAlive).toBe(false)
    expect(result.scratchDirs).toEqual([])
  })
})
