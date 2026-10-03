import { createServer, type Server } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime-client-error-classification'
import { remoteRuntimeConnectFailureMessage } from '../../shared/remote-runtime-connect-bound'
import { openRemoteRuntimeWebSocket } from '../../shared/remote-runtime-request-websocket'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../browser/browser-local-https-test-certificate'

const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
})

// The static localhost identity is self-signed, so Node rejects it the same way it rejects a
// server behind a private CA that only the OS keychain trusts.
async function listenUntrustedWssServer(): Promise<string> {
  const server = createServer({
    cert: LOCAL_HTTPS_TEST_CERTIFICATE,
    key: LOCAL_HTTPS_TEST_PRIVATE_KEY
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return `wss://127.0.0.1:${address.port}`
}

function tlsError(code: string): Error {
  return Object.assign(new Error('certificate check failed'), { code })
}

describe('remote runtime TLS rejection message', () => {
  it('names the rejected certificate instead of a bare connect failure', async () => {
    const endpoint = await listenUntrustedWssServer()
    const keyPair = generateKeyPair()
    const onError = vi.fn()

    const opened = openRemoteRuntimeWebSocket(
      {
        v: 2,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      },
      { onClose: vi.fn(), onError, onTextFrame: vi.fn() },
      5_000
    )
    if (!opened.ok) {
      throw opened.error
    }

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    const error: unknown = onError.mock.calls[0][1]
    opened.socket.cleanup()
    opened.socket.ws.terminate()

    expect(error).toBeInstanceOf(RemoteRuntimeClientError)
    if (!(error instanceof RemoteRuntimeClientError)) {
      return
    }
    expect(error.code).toBe('remote_runtime_unavailable')
    expect(error.message).toContain("the host's TLS certificate was rejected")
    expect(error.message).toContain('(DEPTH_ZERO_SELF_SIGNED_CERT)')
    expect(error.message).toContain('NODE_EXTRA_CA_CERTS')
    // Still a connect failure, so panes keep retrying once the CA is trusted.
    expect(isRecoverableRemoteRuntimeConnectionError({ message: error.message })).toBe(true)
    // The host answered, so the Tailscale remedy would point at the wrong layer.
    expect(withRemoteRuntimeTailscaleHint(error.message, endpoint)).toBe(error.message)
  })

  it('reports the private-CA case from the issue with the CA remedy', () => {
    const message = remoteRuntimeConnectFailureMessage(
      tlsError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
      'wss://orca.internal.example:8443'
    )
    expect(message).toBe(
      "Could not connect to the remote Orca runtime at wss://orca.internal.example:8443: the host's " +
        'TLS certificate was rejected (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). If it uses a private CA, ' +
        'set NODE_EXTRA_CA_CERTS to that CA certificate file and restart Orca.'
    )
  })

  it('omits the CA remedy when trust is not the problem', () => {
    const message = remoteRuntimeConnectFailureMessage(
      tlsError('CERT_HAS_EXPIRED'),
      'wss://orca.example.com'
    )
    expect(message).toContain('(CERT_HAS_EXPIRED)')
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS')
  })

  it('keeps unknown error codes out of the message', () => {
    expect(
      remoteRuntimeConnectFailureMessage(tlsError('ECONNREFUSED'), 'wss://orca.example.com')
    ).toBe('Could not connect to the remote Orca runtime.')
    expect(
      remoteRuntimeConnectFailureMessage(tlsError('terminal_gone'), 'wss://orca.example.com')
    ).toBe('Could not connect to the remote Orca runtime.')
  })
})
