const { existsSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { connect } = require('node:net')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { macTerminalHostPaths } = require('./macos-terminal-host-bundle.cjs')
const {
  daemonProtocolVersion
} = require('../../src/shared/local-build-compatibility-contract.json')

// Why: `asarUnpack` in config/electron-builder.config.cjs lists
// out/main/daemon-entry.js on every platform, and the packaged daemon fork
// (src/main/daemon/daemon-init.ts) resolves exactly this unpacked path. A
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
async function verifyPackagedMacTerminalHostBoots(appPath, { arch }) {
  const paths = macTerminalHostPaths(appPath)
  const prefix = macCommandPrefixForArch(arch)
  if (!prefix) {
    console.log(
      `[verify-packaged-daemon-entry] skipped terminal host boot on ${arch} (host ${process.arch})`
    )
    return 'skipped'
  }
  const stderr = []
  try {
    await runTerminalHostRoundTrip({
      command: [...prefix, paths.executable],
      entry: paths.entry,
      deadline: Date.now() + TERMINAL_HOST_BOOT_TIMEOUT_MS,
      stderr
    })
  } catch (error) {
    throw new Error(
      `[verify-packaged-daemon-entry] the ${arch} terminal host did not serve a PTY: ${error.message}\n${stderr.join('').slice(-2000)}`
    )
  }
  console.log(`[verify-packaged-daemon-entry] OK — ${arch} terminal host served a PTY`)
  return 'booted'
}

module.exports = {
  assertPackagedDaemonEntryExists,
  macCommandPrefixForArch,
  runTerminalHostRoundTrip,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
}
