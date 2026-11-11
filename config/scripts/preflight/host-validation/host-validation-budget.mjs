import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

export function serveValidationLease(server, token) {
  server.on('connection', (socket) => {
    let input = ''
    socket.setTimeout(1000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      input += chunk
      if (input.length > 256) {
        socket.destroy()
      } else if (input.includes('\n')) {
        socket.end(input.trim() === token ? 'ok\n' : 'busy\n')
      }
    })
  })
}

function verifyInheritedLease(port, token) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let output = ''
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('connect', () => socket.write(`${token}\n`))
    socket.on('data', (chunk) => {
      output += chunk
      if (output.length > 16) {
        socket.destroy()
      }
    })
    socket.on('close', () => resolve(output === 'ok\n'))
  })
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(null)
      } else {
        reject(error)
      }
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server))
  })
}

export async function delegateHostValidation() {
  if (process.platform === 'win32' || process.env.GITHUB_ACTIONS === 'true') {
    return false
  }
  const defaultPort =
    43000 + (createHash('sha256').update(homedir()).digest().readUInt16BE() % 2000)
  const port = Number(process.env.ORCA_VALIDATION_PORT ?? defaultPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('ORCA_VALIDATION_PORT must be an integer between 1024 and 65535')
  }
  const inherited = process.env.ORCA_VALIDATION_TOKEN
  if (inherited) {
    if (!(await verifyInheritedLease(port, inherited))) {
      throw new Error('Inherited host validation lane is no longer live; rerun the command')
    }
    return false
  }

  const controller = new AbortController()
  let signalCode = 0
  let child
  const cancel = (signal) => {
    signalCode ||= SIGNAL_CODES[signal]
    controller.abort()
    if (child?.connected) {
      child.send({ type: 'cancel' }, () => {})
    }
  }
  const listeners = Object.keys(SIGNAL_CODES).map((signal) => {
    const listener = () => cancel(signal)
    process.on(signal, listener)
    return [signal, listener]
  })
  const startedAt = performance.now()
  let server
  let heartbeat
  try {
    while (!controller.signal.aborted) {
      server = await tryListen(port)
      if (server) {
        break
      }
      if (!heartbeat) {
        const announce = () =>
          console.error(
            `[validation] waiting for host lane 127.0.0.1:${port}; ${((performance.now() - startedAt) / 1000).toFixed(1)}s queued (${process.cwd()})`
          )
        announce()
        heartbeat = setInterval(announce, 15_000)
      }
      await delay(250 + Math.random() * 250, undefined, { signal: controller.signal })
    }
    if (controller.signal.aborted) {
      return true
    }
    clearInterval(heartbeat)
    console.error(
      `[validation] admitted after ${((performance.now() - startedAt) / 1000).toFixed(1)}s; host lane ${port}`
    )
    const token = randomBytes(24).toString('hex')
    serveValidationLease(server, token)
    const limitThreads = (value) => String(Math.max(1, Math.min(Number(value) || 2, 2)))
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./validation-process-group.mjs', import.meta.url))],
      {
        detached: true,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env,
          ORCA_VALIDATION_PORT: String(port),
          ORCA_VALIDATION_TOKEN: token,
          RAYON_NUM_THREADS: limitThreads(process.env.RAYON_NUM_THREADS),
          GOMAXPROCS: limitThreads(process.env.GOMAXPROCS)
        }
      }
    )
    let result = 1
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('message', (message) => {
        if (message?.type === 'result') {
          result = message.code
        }
      })
      child.on('close', () => resolve(signalCode || result))
      child.send(
        { type: 'start', entry: process.argv[1], args: process.argv.slice(2) },
        server,
        (error) => {
          if (error && child.connected) {
            child.send({ type: 'cancel' }, () => {})
          }
        }
      )
    })
    return true
  } catch (error) {
    if (error.name !== 'AbortError') {
      throw error
    }
    return true
  } finally {
    clearInterval(heartbeat)
    server?.close()
    for (const [signal, listener] of listeners) {
      process.off(signal, listener)
    }
    if (signalCode) {
      process.exitCode = signalCode
    }
  }
}
