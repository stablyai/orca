import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  daemonProtocolVersion
} = require('../../src/shared/local-build-compatibility-contract.json')
const {
  assertPackagedDaemonEntryExists,
  assertPackagedDaemonProtocolAndDeps,
  runTerminalHostRoundTrip,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
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

  function withDaemonMarker(source) {
    return `const PROTOCOL_VERSION = ${daemonProtocolVersion}\n${source}`
  }

  it('passes when the packaged entry loads and reaches argv parsing', () => {
    writePackagedEntry(
      withDaemonMarker('console.error("Usage: daemon-entry <socket>"); process.exit(1)\n')
    )
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).not.toThrow()
  })

  it('fails when the packaged entry cannot resolve its module graph', () => {
    writePackagedEntry(withDaemonMarker('require("orca-module-that-does-not-exist")\n'))
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /failed to load under plain Node/
    )
  })

  it('fails when the packaged entry never reaches argv parsing', () => {
    writePackagedEntry(withDaemonMarker('process.exit(0)\n'))
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(/did not reach argv parsing/)
  })

  it('throws when the unpacked daemon graph has no protocol marker', () => {
    writePackagedEntry('console.error("Usage: daemon-entry"); process.exit(1)\n')
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      new RegExp(
        `unpacked daemon protocol version missing;[\\s\\S]*expected ${daemonProtocolVersion}`
      )
    )
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /unpacked daemon protocol version missing/
    )
  })

  function writeProcessHost(exportsMap, presentFiles) {
    const packageDir = join(resourcesDir, 'node_modules', '@orca', 'process-host')
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ exports: exportsMap }))
    for (const name of presentFiles) {
      writeFileSync(join(packageDir, 'dist', name), '')
    }
  }

  it('throws when a declared @orca/process-host export is missing', () => {
    writePackagedEntry('console.error("Usage: daemon-entry"); process.exit(1)\n')
    writeProcessHost({ './windows-tree-kill': { default: './dist/windows-tree-kill.js' } }, [])
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] missing @orca\/process-host export/
    )
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] missing @orca\/process-host export/
    )
  })

  it('throws when unpacked daemon-entry embeds a stale protocolVersion', () => {
    const stale = daemonProtocolVersion - 2
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst startup = { protocolVersion: ${stale} }\n`
    )
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('rejects a stale protocolVersion in daemon-entry when a chunk has the current daemon marker', () => {
    const stale = daemonProtocolVersion - 1
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst startup = { protocolVersion: ${stale} }\n`
    )
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(
      join(chunksDir, 'socket.js'),
      `const name = "orca-terminal-host-v${daemonProtocolVersion}-x"\n`
    )
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('rejects a stale protocolVersion in daemon-entry when a chunk has the current protocolVersion', () => {
    const stale = daemonProtocolVersion - 1
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst startup = { protocolVersion: ${stale} }\n`
    )
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(
      join(chunksDir, 'startup.js'),
      `const startup = { protocolVersion: ${daemonProtocolVersion} }\n`
    )
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('throws when a chunk socket helper defaults to a stale protocol generation', () => {
    const stale = daemonProtocolVersion - 2
    writePackagedEntry('console.error("Usage: daemon-entry"); process.exit(1)\n')
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(
      join(chunksDir, 'socket.js'),
      `function getDaemonSocketPath(e,t=${stale}){return "orca-terminal-host-v\${t}-x"}\n`
    )
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('rejects a minified socket default whose identifier contains $', () => {
    const stale = daemonProtocolVersion - 1
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst PROTOCOL_VERSION = ${daemonProtocolVersion}\n`
    )
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(
      join(chunksDir, 'socket.js'),
      `const $a=${stale};function getDaemonSocketPath(e){return "orca-terminal-host-v\${$a}-x"}\n`
    )
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('rejects mixed daemon protocol markers and still allows mcp protocolVersion 1', () => {
    const stale = daemonProtocolVersion - 1
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst PROTOCOL_VERSION = ${daemonProtocolVersion}\n`
    )
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(join(chunksDir, 'mcp-initialize.js'), 'call("initialize",{protocolVersion:1})\n')
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).not.toThrow()

    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst startup = { protocolVersion: ${daemonProtocolVersion} }\n`
    )
    writeFileSync(join(chunksDir, 'socket.js'), `const name = "orca-terminal-host-v${stale}-x"\n`)
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )

    rmSync(join(chunksDir, 'socket.js'), { force: true })
    writePackagedEntry(
      `console.error("Usage: daemon-entry"); process.exit(1)\nconst PROTOCOL_VERSION = ${daemonProtocolVersion}\n`
    )
    writeFileSync(join(chunksDir, 'legacy.js'), `const PROTOCOL_VERSION = ${stale}\n`)
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).toThrow(
      /\[verify-packaged-daemon-entry\] unpacked daemon protocol version mismatch/
    )
  })

  it('passes when protocolVersion matches and every process-host export exists', () => {
    writePackagedEntry(
      `console.error("Usage: daemon-entry protocolVersion: ${daemonProtocolVersion}"); process.exit(1)\n`
    )
    writeProcessHost({ './windows-tree-kill': { default: './dist/windows-tree-kill.js' } }, [
      'windows-tree-kill.js'
    ])
    const chunksDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(join(chunksDir, 'mcp-initialize.js'), 'call("initialize",{protocolVersion:1})\n')
    expect(() => assertPackagedDaemonProtocolAndDeps(resourcesDir)).not.toThrow()
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).not.toThrow()
  })
})

describe('terminal host boot check on a slice this host cannot run', () => {
  // No Mac runs a riscv64 binary, so this is the same path as an x64 slice without Rosetta.
  it('fails a release or CI build', async () => {
    await expect(
      verifyPackagedMacTerminalHostBoots('/Orca.app', { arch: 'riscv64', required: true })
    ).rejects.toThrow(/riscv64 cannot run on this/)
  })

  it('lets a local build skip it', async () => {
    await expect(
      verifyPackagedMacTerminalHostBoots('/Orca.app', { arch: 'riscv64', required: false })
    ).resolves.toBeUndefined()
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
