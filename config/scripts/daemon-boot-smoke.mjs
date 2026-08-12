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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

// 'connected' only when something actually answers; a dead entry left on the name is not it.
function probeEndpoint(socketPath) {
  return new Promise((resolveProbe) => {
    const socket = connect(socketPath)
    const settle = (result) => {
      socket.destroy()
      resolveProbe(result)
    }
    socket.on('connect', () => settle('connected'))
    socket.on('error', () => settle('unreachable'))
  })
}

function runDaemonRpc(socketPath, tokenPath, protocolVersion, request, timeoutMs) {
  return new Promise((resolveRpc, rejectRpc) => {
    let settled = false
    let buffer = ''
    const socket = connect(socketPath)
    const finish = (error, response) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        rejectRpc(error)
      } else {
        resolveRpc(response)
      }
    }
    const timer = setTimeout(() => finish(new Error(`${request.type} timed out`)), timeoutMs)

    socket.on('error', (error) => finish(error))
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
          finish(new Error('invalid response line'))
          return
        }
        if (msg.type === 'hello') {
          if (!msg.ok) {
            finish(new Error(`hello rejected: ${msg.error ?? 'unknown'}`))
            return
          }
          socket.write(`${JSON.stringify(request)}\n`)
        } else if (msg.id === request.id) {
          finish(
            msg.ok === true ? undefined : new Error(msg.error ?? `${request.type} failed`),
            msg
          )
          return
        }
        newlineIdx = buffer.indexOf('\n')
      }
    })
  })
}

// Best-effort: constrained CI runners can make node-pty spawn flaky.
async function runPtySpawnHealthCheck(socketPath, tokenPath, protocolVersion) {
  try {
    await runDaemonRpc(
      socketPath,
      tokenPath,
      protocolVersion,
      { id: 'health-1', type: 'ptySpawnHealth' },
      PTY_HEALTH_TIMEOUT_MS
    )
    return true
  } catch (error) {
    log(`PTY spawn health check skipped (best-effort): ${error.message}`)
    return false
  }
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-daemon-boot-smoke-'))
  const socketPath = makeSocketPath(userDataDir)
  const tokenPath = join(userDataDir, 'daemon.token')
  const pidPath = join(userDataDir, 'daemon.pid')
  const launchNonce = randomUUID()
  const protocolVersion = readProtocolVersion()

  log(`forking ${entryPath} under plain Node (${process.execPath})`)
  const child = fork(
    entryPath,
    [
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      '--pid-record',
      pidPath,
      '--launch-nonce',
      launchNonce,
      '--entry-path',
      entryPath,
      '--app-version',
      'daemon-boot-smoke'
    ],
    {
      // Plain Node: no ELECTRON_RUN_AS_NODE. process.execPath is already node in
      // CI, and this is exactly the runtime where a leaked `require("electron")`
      // throws MODULE_NOT_FOUND — the failure this smoke exists to catch.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir }
    }
  )

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
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
    const pidRecord = JSON.parse(readFileSync(pidPath, 'utf8'))
    if (
      pidRecord.pid !== child.pid ||
      pidRecord.launchNonce !== launchNonce ||
      pidRecord.entryPath !== entryPath ||
      pidRecord.appVersion !== 'daemon-boot-smoke'
    ) {
      throw new Error('daemon readiness did not publish the expected PID ownership record')
    }
    log('PID ownership record matches the ready daemon')
    if (!existsSync(socketPath)) {
      throw new Error('daemon did not publish its endpoint at the canonical socket path')
    }
    log('endpoint published at the canonical socket path')
    // Production releases startup-only handles after ready; they can pin the child on Windows.
    // Diagnostics past this point therefore carry the tail captured up to readiness only.
    child.stderr?.destroy()
    stderr += '[boot-smoke] stderr released at readiness, mirroring production\n'
    child.disconnect()

    const ptyHealthy = await runPtySpawnHealthCheck(socketPath, tokenPath, protocolVersion)
    if (ptyHealthy) {
      log('ptySpawnHealth OK — daemon spawned a real PTY end-to-end')
    }

    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        rejectExit(new Error(`daemon did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of shutdown RPC`))
      }, SHUTDOWN_TIMEOUT_MS)
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        log(`daemon exited after shutdown RPC (code=${code}, signal=${signal})`)
        resolveExit()
      })
      void runDaemonRpc(
        socketPath,
        tokenPath,
        protocolVersion,
        {
          id: 'shutdown-1',
          type: 'shutdown',
          payload: { killSessions: false }
        },
        SHUTDOWN_TIMEOUT_MS
      ).catch((error) => {
        clearTimeout(timer)
        rejectExit(error)
      })
    })
    if (existsSync(pidPath)) {
      throw new Error('daemon left its PID ownership record behind after shutdown')
    }
    // Why not "the entry is gone": a departing daemon deliberately leaves its endpoint behind
    // for the next publisher to replace in one rename. What must be true is that nothing
    // answers there any more.
    if (process.platform !== 'win32' && (await probeEndpoint(socketPath)) === 'connected') {
      throw new Error('daemon still answers its endpoint after shutdown')
    }
    // The private bind name is consumed by the publish, and nothing sweeps the runtime dir any
    // more, so a leak here is permanent. Match what the code actually generates rather than a
    // literal prefix: this check silently matched nothing after the namespace moved from .b.
    const leaked = readdirSync(userDataDir).filter((entry) => /^\.[a-z][0-9a-f]{10}$/.test(entry))
    if (leaked.length > 0) {
      throw new Error(`daemon leaked private bind names: ${leaked.join(', ')}`)
    }

    log('PASS: daemon booted, served, and shut down under plain Node')
  } finally {
    cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`[daemon-boot-smoke] FAIL: ${error.message}\n`)
  process.exitCode = 1
})
