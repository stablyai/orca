import { connect } from 'net'
import { setTimeout as delay } from 'timers/promises'

const DEFAULT_READY_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 500
const RETRY_DELAY_MS = 100

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
