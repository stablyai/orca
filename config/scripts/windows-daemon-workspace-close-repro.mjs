/**
 * Reproduces issue #8048 against the built daemon on Windows.
 *
 * A witness PowerShell stays alive while victim sessions receive the same
 * graceful-then-immediate kill pair emitted when Orca closes a workspace.
 * The daemon PID and witness session must survive every iteration.
 */
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '../..')
const entryPath = join(projectDir, 'out', 'main', 'daemon-entry.js')
const iterations = Number(process.env.ORCA_WINDOWS_DAEMON_CLOSE_ITERATIONS ?? 25)
const requestTimeoutMs = 15_000

function log(message) {
  process.stdout.write(`[windows-daemon-workspace-close] ${message}\n`)
}

function readProtocolVersion() {
  const source = readFileSync(
    join(projectDir, 'src/main/daemon/daemon-protocol-version.ts'),
    'utf8'
  )
  const match = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)
  if (!match) {
    throw new Error('Could not read the daemon protocol version')
  }
  return Number(match[1])
}

function createStreamSocket(socketPath, token, protocolVersion, clientId, onFailure) {
  const socket = connect(socketPath)
  let buffer = ''

  return new Promise((resolveStream, rejectStream) => {
    let handshakeComplete = false
    const rejectHandshake = (error) => {
      if (handshakeComplete) {
        onFailure(error)
        return
      }
      handshakeComplete = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      socket.destroy()
      rejectStream(error)
    }
    const onError = (error) => rejectHandshake(error)
    const onClose = () => rejectHandshake(new Error('Daemon stream socket closed'))
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const message = JSON.parse(buffer.slice(0, newline))
      if (message.type !== 'hello') {
        return
      }
      if (!message.ok) {
        rejectHandshake(new Error(message.error ?? 'Daemon rejected stream hello'))
        return
      }
      handshakeComplete = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      // Why: drain terminal events even though this lifecycle repro only asserts through RPC.
      socket.on('data', () => {})
      resolveStream(socket)
    }
    const timer = setTimeout(
      () => rejectHandshake(new Error('Daemon stream hello timed out')),
      requestTimeoutMs
    )
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          version: protocolVersion,
          token,
          clientId,
          role: 'stream'
        })}\n`
      )
    })
  })
}

function createRpcClient(socketPath, tokenPath) {
  const socket = connect(socketPath)
  const clientId = randomUUID()
  const protocolVersion = readProtocolVersion()
  const token = readFileSync(tokenPath, 'utf8').trim()
  const pending = new Map()
  let buffer = ''
  let requestId = 0
  let streamSocket
  let connectionError
  let helloResolve
  let helloReject
  let helloTimer
  const hello = new Promise((resolveHello, rejectHello) => {
    helloResolve = () => {
      clearTimeout(helloTimer)
      resolveHello()
    }
    helloReject = (error) => {
      clearTimeout(helloTimer)
      rejectHello(error)
    }
  })
  helloTimer = setTimeout(() => {
    helloReject(new Error('Daemon control hello timed out'))
    socket.destroy()
  }, requestTimeoutMs)

  const rejectPending = (error) => {
    connectionError ??= error
    helloReject(error)
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  socket.on('error', rejectPending)
  socket.on('close', () => rejectPending(new Error('Daemon control socket closed')))
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.type === 'hello') {
        if (message.ok) {
          helloResolve()
        } else {
          helloReject(new Error(message.error ?? 'Daemon rejected hello'))
        }
      } else if (message.id) {
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.ok) {
            request.resolve(message.payload)
          } else {
            request.reject(new Error(message.error ?? 'Daemon request failed'))
          }
        }
      }
      newline = buffer.indexOf('\n')
    }
  })

  const socketConnected = new Promise((resolveConnected, rejectConnected) => {
    socket.once('connect', resolveConnected)
    socket.once('error', rejectConnected)
  })
  const connected = Promise.all([
    socketConnected.then(() => {
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          version: protocolVersion,
          token,
          clientId,
          role: 'control'
        })}\n`
      )
    }),
    hello
  ]).then(async () => {
    // Why: v24 only admits terminals for the same complete control+stream pair as production.
    streamSocket = await createStreamSocket(
      socketPath,
      token,
      protocolVersion,
      clientId,
      rejectPending
    )
  })

  return {
    async request(type, payload) {
      await connected
      if (connectionError) {
        throw connectionError
      }
      const id = `repro-${++requestId}`
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectRequest(new Error(`Daemon request ${type} timed out`))
        }, requestTimeoutMs)
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
        socket.write(`${JSON.stringify({ id, type, ...(payload ? { payload } : {}) })}\n`)
      })
    },
    close() {
      streamSocket?.destroy()
      socket.destroy()
    }
  }
}

function waitForReady(child, stderr) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`Daemon readiness timed out.\n${stderr()}`)),
      requestTimeoutMs
    )
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer)
        resolveReady()
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      rejectReady(
        new Error(`Daemon exited before readiness (code=${code}, signal=${signal}).\n${stderr()}`)
      )
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((resolveTimeout) =>
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        resolveTimeout()
      }, 5_000)
    )
  ])
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function waitForVictimExit(rpc, sessionId, pid) {
  const deadline = Date.now() + requestTimeoutMs
  while (Date.now() < deadline) {
    const { sessions } = await rpc.request('listSessions')
    const sessionAlive = sessions.some((session) => session.sessionId === sessionId)
    if (!sessionAlive && !isProcessAlive(pid)) {
      return sessions
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Victim ${sessionId} or OS pid ${pid} was not reaped`)
}

async function main() {
  if (process.platform !== 'win32') {
    log('SKIP: Windows ConPTY is required')
    return
  }
  if (!existsSync(entryPath)) {
    throw new Error(`Missing ${entryPath}; run pnpm build:electron-vite first`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'orca-windows-daemon-close-'))
  const socketPath = `\\\\.\\pipe\\orca-daemon-close-${process.pid}-${randomUUID()}`
  const tokenPath = join(scratch, 'daemon.token')
  const daemonLogPath = join(scratch, 'daemon.log')
  const child = fork(
    entryPath,
    ['--socket', socketPath, '--token', tokenPath, '--log-file', daemonLogPath],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, ORCA_USER_DATA_PATH: scratch }
    }
  )
  const daemonPid = child.pid
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  let rpc

  try {
    await waitForReady(child, () => stderr)
    rpc = createRpcClient(socketPath, tokenPath)
    const witnessId = `repro-witness@@${randomUUID().slice(0, 8)}`
    await rpc.request('createOrAttach', {
      sessionId: witnessId,
      cols: 80,
      rows: 24,
      cwd: projectDir,
      shellOverride: 'powershell.exe'
    })

    for (let index = 0; index < iterations; index += 1) {
      const victimId = `repro-victim-${index}@@${randomUUID().slice(0, 8)}`
      const victim = await rpc.request('createOrAttach', {
        sessionId: victimId,
        cols: 80,
        rows: 24,
        cwd: projectDir,
        shellOverride: 'powershell.exe'
      })
      if (!Number.isInteger(victim.pid) || victim.pid <= 0) {
        throw new Error(`Victim ${victimId} did not return a valid OS pid`)
      }

      // Why: sending both RPCs before awaiting either preserves the renderer
      // unmount/worktree-sweep overlap that produced issue #8048.
      const graceful = rpc.request('kill', { sessionId: victimId, immediate: false })
      const forced = rpc.request('kill', { sessionId: victimId, immediate: true })
      await Promise.all([graceful, forced])

      const sessions = await waitForVictimExit(rpc, victimId, victim.pid)
      if (child.pid !== daemonPid || child.exitCode !== null) {
        throw new Error(`Daemon PID ${daemonPid} exited while closing victim ${index}`)
      }
      if (!sessions.some((session) => session.sessionId === witnessId && session.isAlive)) {
        throw new Error(`Witness PTY disappeared while closing victim ${index}`)
      }
    }

    await rpc.request('kill', { sessionId: witnessId, immediate: true })
    log(
      `PASS: ${iterations} victim sessions/PIDs were reaped while daemon ${daemonPid} and the witness PTY survived`
    )
  } catch (error) {
    const daemonLog = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : ''
    throw new Error(`${error.message}\nstderr:\n${stderr}\ndaemon.log:\n${daemonLog}`)
  } finally {
    rpc?.close()
    await stopChild(child)
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`[windows-daemon-workspace-close] FAIL: ${error.message}\n`)
  process.exitCode = 1
})
