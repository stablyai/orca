/**
 * Boots the BUILT terminal daemon (out/main/daemon-entry.js) under plain Node —
 * the exact way production forks it (ELECTRON_RUN_AS_NODE = a plain-Node
 * process) — and asserts it starts, serves a real PTY, and stops.
 *
 * Why this exists: native-smoke CI (and packaging) went green while
 * v1.4.129-rc.1 shipped a daemon that exited code 1 at module load because an
 * electron `require` leaked into its bundle graph. Nothing executed the built
 * entry under plain Node, so the outage was invisible until an adopted old
 * daemon died in the field. This runs on every PR that touches the daemon.
 *
 * Hard assertions (fail the job):
 *   - the daemon signals `{ type: 'ready' }` over IPC within the timeout, and
 *   - it terminates when asked (no hang / zombie).
 * Best-effort (logged skip, never fails): an end-to-end `ptySpawnHealth` RPC,
 * because node-pty spawn can be flaky on constrained CI runners.
 */
import { fork } from 'node:child_process'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '../..')
const entryPath = join(projectDir, 'out', 'main', 'daemon-entry.js')

const READY_TIMEOUT_MS = 30_000
const PTY_HEALTH_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 10_000

function log(message) {
  process.stdout.write(`[daemon-boot-smoke] ${message}\n`)
}

// Why: the daemon rejects a hello whose protocol version differs, so read the
// current version from source rather than hardcoding a number that can drift.
function readProtocolVersion() {
  const protocolSourcePath = 'src/main/daemon/daemon-protocol-version.ts'
  const source = readFileSync(join(projectDir, protocolSourcePath), 'utf8')
  const match = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)
  if (!match) {
    throw new Error(`could not read PROTOCOL_VERSION from ${protocolSourcePath}`)
  }
  return Number(match[1])
}

function makeSocketPath(userDataDir) {
  // Why: Windows AF_UNIX-style IPC uses named pipes; POSIX uses a filesystem
  // socket kept under the scratch userData dir so cleanup removes it.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\orca-daemon-smoke-${process.pid}-${randomUUID()}`
  }
  return join(userDataDir, 'daemon.sock')
}

// Best-effort end-to-end PTY check over the daemon's own control-socket RPC.
// Connects a single control socket, completes the hello handshake, and calls
// `ptySpawnHealth` (the daemon spawns a throwaway PTY internally). Resolves
// true on success, false on any failure — never throws.
function runPtySpawnHealthCheck(socketPath, tokenPath, protocolVersion) {
  return new Promise((resolveCheck) => {
    let settled = false
    let buffer = ''
    const socket = connect(socketPath)
    const finish = (ok, reason) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (!ok && reason) {
        log(`PTY spawn health check skipped (best-effort): ${reason}`)
      }
      resolveCheck(ok)
    }
    const timer = setTimeout(() => finish(false, 'timed out'), PTY_HEALTH_TIMEOUT_MS)

    socket.on('error', (err) => finish(false, err.message))
    socket.on('connect', () => {
      const token = readFileSync(tokenPath, 'utf8').trim()
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          version: protocolVersion,
          token,
          clientId: randomUUID(),
          role: 'control'
        })}\n`
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          finish(false, 'invalid response line')
          return
        }
        if (msg.type === 'hello') {
          if (!msg.ok) {
            finish(false, `hello rejected: ${msg.error ?? 'unknown'}`)
            return
          }
          socket.write(`${JSON.stringify({ id: 'health-1', type: 'ptySpawnHealth' })}\n`)
        } else if (msg.id === 'health-1') {
          finish(
            msg.ok === true,
            msg.ok === true ? undefined : (msg.error ?? 'ptySpawnHealth failed')
          )
          return
        }
        newlineIdx = buffer.indexOf('\n')
      }
    })
  })
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-daemon-boot-smoke-'))
  const socketPath = makeSocketPath(userDataDir)
  const tokenPath = join(userDataDir, 'daemon.token')
  const protocolVersion = readProtocolVersion()

  log(`forking ${entryPath} under plain Node (${process.execPath})`)
  const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
    // Plain Node: no ELECTRON_RUN_AS_NODE. process.execPath is already node in
    // CI, and this is exactly the runtime where a leaked `require("electron")`
    // throws MODULE_NOT_FOUND — the failure this smoke exists to catch.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir }
  })

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk)
  })

  const cleanup = () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }

  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(
          new Error(
            `daemon did not signal 'ready' within ${READY_TIMEOUT_MS}ms.\nstderr:\n${stderr}`
          )
        )
      }, READY_TIMEOUT_MS)
      child.on('message', (msg) => {
        if (msg && typeof msg === 'object' && msg.type === 'ready') {
          clearTimeout(timer)
          resolveReady()
        }
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        rejectReady(new Error(`daemon fork errored: ${err.message}\nstderr:\n${stderr}`))
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        rejectReady(
          new Error(
            `daemon exited before 'ready' (code=${code}, signal=${signal}).\nstderr:\n${stderr}`
          )
        )
      })
    })
    log('daemon signaled ready')

    const ptyHealthy = await runPtySpawnHealthCheck(socketPath, tokenPath, protocolVersion)
    if (ptyHealthy) {
      log('ptySpawnHealth OK — daemon spawned a real PTY end-to-end')
    }

    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        rejectExit(new Error(`daemon did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`))
      }, SHUTDOWN_TIMEOUT_MS)
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        log(`daemon exited after signal (code=${code}, signal=${signal})`)
        resolveExit()
      })
      // Why: SIGTERM is the graceful stop on POSIX (the daemon handles it);
      // Windows has no POSIX signal delivery, so Node maps this to process
      // termination. Either way the hard assertion is "it stops, no hang".
      child.kill('SIGTERM')
    })

    log('PASS: daemon booted, served, and shut down under plain Node')
  } finally {
    cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`[daemon-boot-smoke] FAIL: ${error.message}\n`)
  process.exitCode = 1
})
