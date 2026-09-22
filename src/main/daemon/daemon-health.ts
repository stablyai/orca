import { existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import {
  PROTOCOL_VERSION,
  type HelloMessage,
  type HelloResponse,
  type SystemResolverHealth,
  type SystemResolverHealthResult
} from './types'

const HEALTH_CHECK_TIMEOUT_MS = 3_000
const RESOLVER_HEALTH_CHECK_TIMEOUT_MS = 3_000
// Why: e2e forces the failed-health preserve path without SIGSTOP races —
// a stopped daemon also blocks listSessions, so the unhealthy guard cannot
// verify live sessions until SIGCONT, which is flaky under CI load.
export const E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV = 'ORCA_E2E_FORCE_DAEMON_HEALTH_UNREACHABLE'

// 'rejected' means the daemon answered and refused the handshake (bad token,
// foreign protocol) — it can never be adopted, unlike 'unreachable', which
// also covers a live-but-wedged daemon that simply missed the RPC budget.
export type DaemonHealth = 'healthy' | 'unreachable' | 'rejected' | 'pty-spawn-unhealthy'

export function checkDaemonHealth(socketPath: string, tokenPath: string): Promise<DaemonHealth> {
  return new Promise((resolve) => {
    if (process.env[E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV] === '1') {
      resolve('unreachable')
      return
    }

    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve('unreachable')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unreachable')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: DaemonHealth): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve(result)
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unreachable')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: 'health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
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
          settle('rejected')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('rejected')
            return
          }
          // Why: a protocol-live daemon with a stale cwd or node-pty helper
          // will answer ping but cannot create terminals, so reuse must check
          // the PTY spawn prerequisites too.
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ptySpawnHealth' }))
          continue
        }

        if (message.id === 'health-1') {
          settle(message.ok === true ? 'healthy' : 'pty-spawn-unhealthy')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unreachable'), HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

export async function healthCheckDaemon(socketPath: string, tokenPath: string): Promise<boolean> {
  return (await checkDaemonHealth(socketPath, tokenPath)) === 'healthy'
}

function isSystemResolverHealth(value: unknown): value is SystemResolverHealth {
  return value === 'healthy' || value === 'unhealthy' || value === 'unknown'
}

export function getMacDaemonSystemResolverHealth(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<SystemResolverHealth> {
  if (process.platform !== 'darwin') {
    return Promise.resolve('unknown')
  }

  return new Promise((resolve) => {
    if (!existsSync(socketPath)) {
      resolve('unknown')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unknown')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: SystemResolverHealth): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve(result)
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unknown')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: protocolVersion,
        token,
        clientId: 'resolver-health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
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
          settle('unknown')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('unknown')
            return
          }
          // Why: the daemon must report health from inside its own process;
          // external launchctl bsexec probes can misclassify healthy PTYs.
          sock?.write(
            encodeNdjson({
              id: 'resolver-health-1',
              type: 'systemResolverHealth'
            })
          )
          continue
        }

        if (message.id === 'resolver-health-1') {
          if (!message.ok || typeof message.payload !== 'object' || message.payload === null) {
            settle('unknown')
            return
          }
          const payload = message.payload as Partial<SystemResolverHealthResult>
          settle(isSystemResolverHealth(payload.health) ? payload.health : 'unknown')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unknown'), RESOLVER_HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}
