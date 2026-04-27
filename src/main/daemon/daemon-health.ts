import { execFileSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { connect, type Socket } from 'net'
import { encodeNdjson } from './ndjson'
import { getDaemonPidPath } from './daemon-spawner'
import { PROTOCOL_VERSION, type HelloMessage, type HelloResponse } from './types'

const HEALTH_CHECK_TIMEOUT_MS = 3_000
const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100

function canConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, 500)
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export function healthCheckDaemon(socketPath: string, tokenPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve(false)
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock?.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => settle(false), HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', () => settle(false))
    sock.on('connect', () => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: 'health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    })

    let buffer = ''
    sock.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          settle(false)
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle(false)
            return
          }
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ping' }))
          continue
        }

        if (message.id === 'health-1') {
          settle(Boolean(message.ok))
          return
        }
      }
    })
  })
}

function commandLineMatchesDaemon(
  commandLine: string,
  socketPath: string,
  tokenPath: string
): boolean {
  return (
    commandLine.includes('daemon-entry') &&
    commandLine.includes(socketPath) &&
    commandLine.includes(tokenPath)
  )
}

function isDaemonProcess(pid: number, socketPath: string, tokenPath: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
        ],
        {
          encoding: 'utf8',
          timeout: 3_000
        }
      )
      // Why: image names are too broad after PID reuse. Match the daemon entry
      // plus the exact socket/token args so we only kill the daemon for this
      // userData protocol endpoint.
      return commandLineMatchesDaemon(output, socketPath, tokenPath)
    } catch {
      return false
    }
  }

  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return commandLineMatchesDaemon(cmdline, socketPath, tokenPath)
  } catch {
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000
      })
      return commandLineMatchesDaemon(output, socketPath, tokenPath)
    } catch {
      return false
    }
  }
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<boolean> {
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  let killedDaemon = false
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    if (Number.isFinite(pid) && isDaemonProcess(pid, socketPath, tokenPath)) {
      process.kill(pid, 'SIGTERM')
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
      }
      if (!exited) {
        try {
          process.kill(pid, 'SIGKILL')
          exited = true
        } catch {
          // Already dead
        }
      }
      killedDaemon = exited
    }
  } catch {
    // PID file missing or process already dead
  }

  try {
    unlinkSync(pidPath)
  } catch {
    // Best-effort
  }

  const socketIsLive = await canConnectSocket(socketPath)
  if (process.platform !== 'win32' && existsSync(socketPath) && (killedDaemon || !socketIsLive)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Best-effort
    }
  }
  return killedDaemon
}
