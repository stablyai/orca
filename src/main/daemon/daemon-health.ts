import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import { ptySpawnHealthPlatformCoverage } from './daemon-health-identity'
import { daemonSocketDirIsTrusted } from './daemon-socket-endpoint-path'
import {
  PROTOCOL_VERSION,
  type HelloMessage,
  type HelloResponse,
  type SystemResolverHealth,
  type SystemResolverHealthResult
} from './types'

const HEALTH_CHECK_TIMEOUT_MS = 3_000
const RESOLVER_HEALTH_CHECK_TIMEOUT_MS = 3_000
// SIGSTOP also blocks listSessions; inject failure so e2e can test preserving live sessions reliably.
export const E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV = 'ORCA_E2E_FORCE_DAEMON_HEALTH_UNREACHABLE'

// Rejected means handshake refusal or malformed reply; unreachable includes live but slow daemons.
export type DaemonHealth = 'healthy' | 'unreachable' | 'rejected' | 'pty-spawn-unhealthy'

export type DaemonHealthCheck = {
  verdict: DaemonHealth
  coverage: 'pty-spawn' | 'handshake'
}

function readPtySpawnHealthCoverage(
  payload: unknown,
  fallback: DaemonHealthCheck['coverage']
): DaemonHealthCheck['coverage'] {
  if (typeof payload !== 'object' || payload === null) {
    return fallback
  }
  const coverage = 'coverage' in payload ? payload.coverage : undefined
  return coverage === 'pty-spawn' || coverage === 'handshake' ? coverage : fallback
}

export function checkDaemonHealthWithCoverage(
  socketPath: string,
  tokenPath: string
): Promise<DaemonHealthCheck> {
  return new Promise((resolve) => {
    // Missing coverage from older Windows daemons proves only the handshake, never PTY spawning.
    const fallbackCoverage = ptySpawnHealthPlatformCoverage()
    const resolveVerdict = (verdict: DaemonHealth): void =>
      resolve({ verdict, coverage: fallbackCoverage })
    if (process.env[E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV] === '1') {
      resolveVerdict('unreachable')
      return
    }

    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolveVerdict('unreachable')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolveVerdict('unreachable')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: DaemonHealthCheck): void => {
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
    const onError = (): void => settle({ verdict: 'unreachable', coverage: fallbackCoverage })
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
          settle({ verdict: 'rejected', coverage: fallbackCoverage })
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle({ verdict: 'rejected', coverage: fallbackCoverage })
            return
          }
          // Ping cannot detect stale cwd or PTY-helper failures; check spawn prerequisites before reuse.
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ptySpawnHealth' }))
          continue
        }

        if (message.id === 'health-1') {
          settle({
            verdict: message.ok === true ? 'healthy' : 'pty-spawn-unhealthy',
            coverage: readPtySpawnHealthCoverage(message.payload, fallbackCoverage)
          })
          return
        }
      }
    }
    const timer = setTimeout(
      () => settle({ verdict: 'unreachable', coverage: fallbackCoverage }),
      HEALTH_CHECK_TIMEOUT_MS
    )

    if (!daemonSocketDirIsTrusted(socketPath)) {
      settle({ verdict: 'unreachable', coverage: fallbackCoverage })
      return
    }
    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

export async function checkDaemonHealth(
  socketPath: string,
  tokenPath: string
): Promise<DaemonHealth> {
  return (await checkDaemonHealthWithCoverage(socketPath, tokenPath)).verdict
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
      sock?.off('close', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unknown')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: protocolVersion,
        token,
        // Unique per probe: the daemon evicts an older control socket that reuses a clientId.
        clientId: `resolver-health-check-${randomUUID()}`,
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
          // Probe inside the daemon: external launchctl bsexec can misclassify its resolver health.
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

    if (!daemonSocketDirIsTrusted(socketPath)) {
      settle('unknown')
      return
    }
    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('close', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}
