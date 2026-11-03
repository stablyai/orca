import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getMainHttpClient } from '../network/http-client'

const DEFAULT_READY_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 500
const RETRY_DELAY_MS = 100
const DIAGNOSTICS_TIMEOUT_MS = 5_000

type TcpEndpoint = {
  host: string
  port: number
}

function parseTcpEndpoint(endpoint: string): TcpEndpoint | null {
  try {
    const url = new URL(endpoint)
    const fallbackPort = url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
    const port = url.port ? Number(url.port) : fallbackPort
    if (!url.hostname || !Number.isFinite(port)) {
      return null
    }
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

function canConnectToEndpoint(endpoint: TcpEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    socket.unref()
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) {
        return
      }
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function waitForServeSimEndpointReady(
  endpoint: string,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS
): Promise<boolean> {
  const target = parseTcpEndpoint(endpoint)
  if (!target) {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await canConnectToEndpoint(target)) {
      return true
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return false
    }
    await delay(Math.min(RETRY_DELAY_MS, remaining))
  }
  return false
}

function getServeSimLoopbackOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    ) {
      return url.origin
    }
  } catch {}
  return null
}

// A 404 identifies pre-diagnostics helpers; null means the helper version is unknown.
export async function readServeSimHelperVersion(endpoint: string): Promise<string | 404 | null> {
  const origin = getServeSimLoopbackOrigin(endpoint)
  if (!origin) {
    return null
  }
  try {
    const response = await getMainHttpClient().fetch(`${origin}/api/diagnostics`, {
      signal: AbortSignal.timeout(DIAGNOSTICS_TIMEOUT_MS),
      redirect: 'error'
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return response.status === 404 ? 404 : null
    }
    const diagnostics: unknown = JSON.parse(await response.text())
    if (
      !diagnostics ||
      typeof diagnostics !== 'object' ||
      Array.isArray(diagnostics) ||
      !('serve_sim' in diagnostics)
    ) {
      return null
    }
    const { serve_sim } = diagnostics
    if (
      !serve_sim ||
      typeof serve_sim !== 'object' ||
      Array.isArray(serve_sim) ||
      !('version' in serve_sim)
    ) {
      return null
    }
    return typeof serve_sim.version === 'string' ? serve_sim.version : null
  } catch {
    return null
  }
}
