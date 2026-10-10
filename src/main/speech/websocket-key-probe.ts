import type WebSocket from 'ws'
import type { CloudSpeechKeyTestResult } from '../../shared/cloud-speech-providers'
import { describeProviderFailure, redactCloudSpeechSecrets } from './cloud-speech-provider-errors'
import { openProviderWebSocket } from './cloud-speech-websocket'

export type WebSocketKeyProbe = {
  label: string
  url: string | URL
  headers: Record<string, string>
  apiKey: string
  timeoutMs: number
  /** Sends the short silent session once the handshake succeeds. */
  sendProbe: (socket: WebSocket) => void
  /** Verdict for a provider text frame, or null to keep waiting. */
  readFrame: (raw: string) => CloudSpeechKeyTestResult | null
  /** Message for a handshake the provider refused with an HTTP status. */
  describeRefusedHandshake: (status: number) => string
  /** Verdict for a provider-initiated close, or null to report it as premature. */
  readClose?: (code: number) => CloudSpeechKeyTestResult | null
}

/**
 * Runs one bounded key check on a provider's streaming endpoint: the socket is always
 * closed, and every failure message is stripped of the key before it leaves.
 */
export function runWebSocketKeyProbe(probe: WebSocketKeyProbe): Promise<CloudSpeechKeyTestResult> {
  const { label, apiKey } = probe
  return new Promise((resolve) => {
    let socket: WebSocket | null = null
    let settled = false
    const timer = setTimeout(() => fail(`${label} did not respond in time.`), probe.timeoutMs)
    timer.unref?.()

    function settle(result: CloudSpeechKeyTestResult): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      closeProviderSocketQuietly(socket)
      resolve(result)
    }

    function fail(message: string): void {
      // Why: providers can echo a key of any shape, which the pattern redaction would miss.
      const withoutKey = apiKey ? message.split(apiKey).join('[redacted]') : message
      settle({ ok: false, message: redactCloudSpeechSecrets(withoutKey) })
    }

    function deliver(result: CloudSpeechKeyTestResult): void {
      if (result.ok) {
        settle(result)
      } else {
        fail(result.message ?? `${label} could not confirm the key.`)
      }
    }

    try {
      socket = openProviderWebSocket(probe.url, probe.headers)
    } catch (error) {
      fail(`Could not reach ${label}: ${describeProviderFailure(label, error)}`)
      return
    }
    const opened = socket
    opened.on('open', () => probe.sendProbe(opened))
    opened.on('message', (data, isBinary) => {
      const verdict = isBinary ? null : probe.readFrame(data.toString())
      if (verdict) {
        deliver(verdict)
      }
    })
    opened.on('unexpected-response', (request, response) => {
      request.destroy()
      fail(probe.describeRefusedHandshake(response.statusCode ?? 0))
    })
    opened.on('error', (error) =>
      fail(`Could not reach ${label}: ${describeProviderFailure(label, error)}`)
    )
    opened.on('close', (code) => {
      const verdict = probe.readClose?.(code) ?? null
      if (verdict) {
        deliver(verdict)
      } else {
        fail(`${label} closed the connection before confirming the key (${code}).`)
      }
    })
  })
}

export function closeProviderSocketQuietly(socket: WebSocket | null): void {
  if (!socket) {
    return
  }
  socket.removeAllListeners()
  // Why: a late socket error after removeAllListeners would otherwise crash the main process.
  socket.on('error', () => {})
  if (socket.readyState === socket.OPEN) {
    socket.close(1000)
  } else {
    socket.terminate()
  }
}

/** Shared 401/403 wording so every provider reports a refused key the same way. */
export function describeRejectedKey(label: string, status: number, detail = ''): string {
  // Why: 403 often means billing or permissions on a valid key, so it is worded apart from 401.
  const verdict = status === 403 ? 'denied access for' : 'rejected'
  return `${label} ${verdict} this API key (${status}). ${detail}`.trim()
}
