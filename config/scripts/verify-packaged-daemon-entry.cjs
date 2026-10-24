const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { connect } = require('node:net')
const { tmpdir } = require('node:os')
const { join, relative } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { macTerminalHostPaths } = require('./macos-terminal-host-bundle.cjs')
const {
  daemonProtocolVersion
} = require('../../src/shared/local-build-compatibility-contract.json')

// Why: `asarUnpack` in config/electron-builder.config.cjs lists
// out/main/daemon-entry.js on every platform, and the packaged daemon fork
// (src/main/daemon/daemon-launch-paths.ts) resolves exactly this unpacked path. A
// missing entry means the package layout regressed, so the check throws
// instead of skipping — a silent skip false-passed exactly the layout bug
// this gate exists to catch.
function assertPackagedDaemonEntryExists(resourcesDir) {
  const entryPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-daemon-entry] missing unpacked daemon entry at ${entryPath} — ` +
        `asarUnpack expects out/main/daemon-entry.js on every platform, so the packaged ` +
        `daemon cannot be forked from this layout`
    )
  }
  return entryPath
}

function exportDefaultPath(entry) {
  if (typeof entry === 'string') {
    return entry
  }
  if (entry && typeof entry === 'object' && typeof entry.default === 'string') {
    return entry.default
  }
  return null
}

function assertPackagedProcessHostExports(resourcesDir) {
  const packageDir = join(resourcesDir, 'node_modules', '@orca', 'process-host')
  const packageJsonPath = join(packageDir, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (!pkg.exports || typeof pkg.exports !== 'object') {
    return
  }
  for (const entry of Object.values(pkg.exports)) {
    const target = exportDefaultPath(entry)
    if (!target || !target.endsWith('.js')) {
      continue
    }
    const filePath = join(packageDir, target)
    if (!existsSync(filePath)) {
      throw new Error(
        `[verify-packaged-daemon-entry] missing @orca/process-host export ${target} at ${filePath}`
      )
    }
  }
}

function protocolVersionsInSource(source) {
  const genericVersions = []
  const daemonVersions = []
  for (const match of source.matchAll(/orca-terminal-host-v(\d+)/g)) {
    daemonVersions.push(Number(match[1]))
  }
  for (const match of source.matchAll(/protocolVersion\s*:\s*(\d+)/g)) {
    genericVersions.push(Number(match[1]))
  }
  for (const match of source.matchAll(/\bPROTOCOL_VERSION\s*=\s*(\d+)/g)) {
    daemonVersions.push(Number(match[1]))
  }
  for (const match of source.matchAll(/orca-terminal-host-v\$\{([A-Za-z_$][\w$]*)\}/g)) {
    const name = match[1]
    const escapedName = name.replaceAll('$', '\\$')
    const window = source.slice(Math.max(0, match.index - 220), match.index)
    const defaults = [
      ...window.matchAll(new RegExp(`(?<![\\w$])${escapedName}\\s*=\\s*(\\d+)`, 'g'))
    ]
    const found = defaults.at(-1)
    if (found) {
      daemonVersions.push(Number(found[1]))
    }
  }
  return { genericVersions, daemonVersions }
}

function unpackedDaemonJsFiles(resourcesDir) {
  const mainDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
  const files = [join(mainDir, 'daemon-entry.js')]
  const chunksDir = join(mainDir, 'chunks')
  if (!existsSync(chunksDir)) {
    return files
  }
  for (const name of readdirSync(chunksDir)) {
    if (name.endsWith('.js')) {
      files.push(join(chunksDir, name))
    }
  }
  return files
}

function throwProtocolMismatch(versions) {
  const found = [...new Set(versions)].sort((left, right) => left - right).join(', ')
  throw new Error(
    `[verify-packaged-daemon-entry] unpacked daemon protocol version mismatch: ` +
      `found ${found}; expected ${daemonProtocolVersion}`
  )
}

function packagedFileVersionsMatch(file) {
  if (file.daemonEntry) {
    return [...file.daemonVersions, ...file.genericVersions].every(
      (version) => version === daemonProtocolVersion
    )
  }
  return (
    file.daemonVersions.every((version) => version === daemonProtocolVersion) &&
    file.genericVersions.every((version) => version === daemonProtocolVersion || version === 1)
  )
}

// Why: a current daemon marker in one file must not hide a stale protocolVersion in another.
// Chunks may still carry MCP protocolVersion:1. The contract version must appear at least once.
function assertReferencedProtocolVersions(files) {
  const daemonVersions = []
  const genericVersions = []
  for (const file of files) {
    daemonVersions.push(...file.daemonVersions)
    genericVersions.push(...file.genericVersions)
  }
  if (daemonVersions.length === 0 && genericVersions.length === 0) {
    throw new Error(
      `[verify-packaged-daemon-entry] unpacked daemon protocol version missing; ` +
        `expected ${daemonProtocolVersion}`
    )
  }
  const found = [...daemonVersions, ...genericVersions]
  if (
    files.some((file) => !packagedFileVersionsMatch(file)) ||
    !found.includes(daemonProtocolVersion)
  ) {
    throwProtocolMismatch(found)
  }
}

function assertPackagedDaemonProtocolAndDeps(resourcesDir) {
  assertPackagedProcessHostExports(resourcesDir)
  const entryPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
  const files = []
  for (const filePath of unpackedDaemonJsFiles(resourcesDir)) {
    if (!existsSync(filePath)) {
      continue
    }
    const found = protocolVersionsInSource(readFileSync(filePath, 'utf8'))
    files.push({
      daemonEntry: filePath === entryPath,
      daemonVersions: found.daemonVersions,
      genericVersions: found.genericVersions
    })
  }
  assertReferencedProtocolVersions(files)
}

// Why: v1.4.129-rc.1 shipped a terminal daemon that could not load (an electron
// `require` leaked into its bundle) while every build check passed. This boots
// the PACKAGED daemon-entry under plain Node against the asar-unpacked layout,
// so a bundling / asar-unpack regression fails packaging instead of reaching
// users. Module-load proof only: with no args the entry must reach argv parsing
// and print its "Usage: daemon-entry" error — a MODULE_NOT_FOUND or a missing
// usage line means the packaged graph does not load and the build must fail.
//
// resourcesDir is the packaged Resources dir (Contents/Resources on macOS,
// <appOutDir>/resources elsewhere). execPath defaults to the packaging Node.
function verifyPackagedDaemonEntryBoots(resourcesDir, options = {}) {
  const execPath = options.execPath || process.execPath
  const entryPath = assertPackagedDaemonEntryExists(resourcesDir)
  assertPackagedDaemonProtocolAndDeps(resourcesDir)

  const result = spawnSync(execPath, [entryPath], { encoding: 'utf8', timeout: 10_000 })
  if (result.error) {
    throw new Error(
      `[verify-packaged-daemon-entry] could not launch daemon-entry.js: ${result.error.message}`
    )
  }
  const stderr = result.stderr || ''
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js failed to load under plain Node:\n${stderr}`
    )
  }
  if (!stderr.includes('Usage: daemon-entry')) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js did not reach argv parsing ` +
        `(expected the "Usage: daemon-entry" error). stderr:\n${stderr}`
    )
  }
  console.log('[verify-packaged-daemon-entry] OK — packaged daemon-entry loads under plain Node')
}

const TERMINAL_HOST_BOOT_TIMEOUT_MS = 20_000
// Arithmetic so the shell echoing the typed command cannot satisfy the check.
const TERMINAL_HOST_BOOT_COMMAND = 'echo "OK $((6*7))" && exit'
const TERMINAL_HOST_BOOT_OUTPUT = 'OK 42'

/** The command prefix that runs a `targetArch` Mach-O here, or null when this host cannot. */
function macCommandPrefixForArch(targetArch, run = spawnSync) {
  if (targetArch === process.arch) {
    return []
  }
  if (targetArch === 'x64' && process.arch === 'arm64') {
    const rosetta = run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 10_000 })
    return rosetta.status === 0 ? ['/usr/bin/arch', '-x86_64'] : null
  }
  return null
}

/** Settles with `promise`, or rejects once `deadline` passes. */
function beforeDeadline(promise, deadline, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      Math.max(0, deadline - Date.now())
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * One NDJSON daemon connection. `ready` settles on the hello reply; `broken` rejects when the
 * connection errors, closes or sends a line that is not JSON, at any point.
 */
function openDaemonConnection(socketPath, hello) {
  const socket = connect(socketPath)
  const listeners = []
  let fail
  const broken = new Promise((_, reject) => {
    fail = (error) => {
      reject(error)
      socket.destroy()
    }
  })
  broken.catch(() => {})
  let greet
  const greeted = new Promise((resolve) => {
    greet = resolve
  })
  let isGreeted = false
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', (error) => fail(error))
  socket.on('close', () => fail(new Error(`the daemon closed the ${hello.role} connection`)))
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        fail(new Error(`the daemon sent a non-JSON ${hello.role} line: ${line.slice(0, 200)}`))
        return
      }
      if (!isGreeted) {
        isGreeted = true
        if (message?.ok) {
          greet()
        } else {
          fail(new Error(`daemon rejected ${hello.role} hello: ${message?.error}`))
        }
        continue
      }
      for (const listener of listeners) {
        listener(message)
      }
    }
  })
  socket.write(`${JSON.stringify({ type: 'hello', ...hello })}\n`)
  return {
    socket,
    broken,
    ready: Promise.race([greeted, broken]),
    onMessage: (listener) => listeners.push(listener)
  }
}

async function stopDaemon(daemon, isExited) {
  if (isExited()) {
    return
  }
  const exited = new Promise((resolve) => daemon.once('exit', resolve))
  const waitForExit = (ms) =>
    beforeDeadline(exited, Date.now() + ms, 'the daemon to exit').catch(() => {})
  daemon.kill('SIGTERM')
  await waitForExit(3_000)
  if (!isExited()) {
    daemon.kill('SIGKILL')
    await waitForExit(1_000)
  }
}

async function runTerminalHostRoundTrip({
  command,
  entry,
  deadline,
  stderr,
  scratchPrefix = '/tmp/oth-'
}) {
  // A short path: the socket must fit sun_path.
  const scratch = mkdtempSync(scratchPrefix)
  const socketPath = join(scratch, 'd.sock')
  const tokenPath = join(scratch, 'token')
  const env = { ...process.env, ORCA_USER_DATA_PATH: join(scratch, 'user-data') }
  delete env.ELECTRON_RUN_AS_NODE
  const daemon = spawn(
    command[0],
    [...command.slice(1), entry, '--socket', socketPath, '--token', tokenPath],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let exited = false
  daemon.on('exit', () => {
    exited = true
  })
  daemon.on('error', (error) => {
    exited = true
    stderr.push(error.message)
  })
  daemon.stderr.setEncoding('utf8')
  daemon.stderr.on('data', (chunk) => stderr.push(chunk))
  // If something exits the process mid-check, still leave no daemon or scratch dir behind.
  const cleanupOnExit = () => {
    daemon.kill('SIGKILL')
    rmSync(scratch, { recursive: true, force: true })
  }
  process.once('exit', cleanupOnExit)
  const connections = []
  try {
    // The first exec of a freshly signed binary can be slow while the system assesses it.
    while (!(existsSync(socketPath) && existsSync(tokenPath) && statSync(tokenPath).size > 0)) {
      if (exited || Date.now() > deadline) {
        throw new Error(exited ? 'the daemon exited before it was ready' : 'no daemon token')
      }
      await delay(100)
    }
    const token = readFileSync(tokenPath, 'utf8').trim()
    const clientId = randomUUID()
    const hello = { version: daemonProtocolVersion, token, clientId }
    const control = openDaemonConnection(socketPath, { ...hello, role: 'control' })
    connections.push(control)
    await beforeDeadline(control.ready, deadline, 'the control hello reply')
    const stream = openDaemonConnection(socketPath, { ...hello, role: 'stream' })
    connections.push(stream)
    await beforeDeadline(stream.ready, deadline, 'the stream hello reply')
    let output = ''
    const sawOutput = new Promise((resolve) => {
      stream.onMessage((message) => {
        output += message?.payload?.data ?? ''
        if (output.includes(TERMINAL_HOST_BOOT_OUTPUT)) {
          resolve()
        }
      })
    })
    control.onMessage((message) => {
      if (message?.id === 'boot-1' && message.ok === false) {
        stderr.push(`createOrAttach failed: ${message.error}`)
      }
    })
    control.socket.write(
      `${JSON.stringify({
        id: 'boot-1',
        type: 'createOrAttach',
        payload: {
          sessionId: 'terminal-host-boot',
          cols: 80,
          rows: 24,
          cwd: scratch,
          command: TERMINAL_HOST_BOOT_COMMAND
        }
      })}\n`
    )
    try {
      await beforeDeadline(
        Promise.race([sawOutput, control.broken, stream.broken]),
        deadline,
        `"${TERMINAL_HOST_BOOT_OUTPUT}" from the PTY`
      )
    } catch (error) {
      throw new Error(`${error.message}; output: ${output.slice(-400)}`)
    }
  } finally {
    for (const connection of connections) {
      connection.socket.destroy()
    }
    await stopDaemon(daemon, () => exited)
    process.removeListener('exit', cleanupOnExit)
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Why: the helper's own Node must load node-pty and serve a PTY; a `Usage:` boot never loads
// node-pty. Release builds run it under hardened runtime, so allow-jit and same-team library
// validation are exercised before notarization.
async function verifyPackagedMacTerminalHostBoots(appPath, { arch, required }) {
  const paths = macTerminalHostPaths(appPath)
  const prefix = macCommandPrefixForArch(arch)
  if (!prefix) {
    const message = `terminal host boot on ${arch} cannot run on this ${process.arch} host`
    if (required) {
      throw new Error(`[verify-packaged-daemon-entry] the ${message}`)
    }
    console.log(`[verify-packaged-daemon-entry] skipped ${message}`)
    return
  }
  const stderr = []
  // Boot a clone outside the build tree, as installs do, so no ancestor node_modules can
  // satisfy a require the helper lacks.
  const isolated = mkdtempSync(join(tmpdir(), 'orca-terminal-host-boot-'))
  const clone = join(isolated, 'Orca Terminal Host.app')
  try {
    const cloned = spawnSync('/bin/cp', ['-cR', paths.bundle, clone], { encoding: 'utf8' })
    if (cloned.status !== 0) {
      throw new Error(`could not clone the helper: ${cloned.stderr.trim()}`)
    }
    await runTerminalHostRoundTrip({
      command: [...prefix, join(clone, relative(paths.bundle, paths.executable))],
      entry: join(clone, relative(paths.bundle, paths.entry)),
      deadline: Date.now() + TERMINAL_HOST_BOOT_TIMEOUT_MS,
      stderr
    })
  } catch (error) {
    throw new Error(
      `[verify-packaged-daemon-entry] the ${arch} terminal host did not serve a PTY: ${error.message}\n${stderr.join('').slice(-2000)}`
    )
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
  console.log(`[verify-packaged-daemon-entry] OK — ${arch} terminal host served a PTY`)
}

module.exports = {
  assertPackagedDaemonEntryExists,
  assertPackagedDaemonProtocolAndDeps,
  macCommandPrefixForArch,
  runTerminalHostRoundTrip,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
}
