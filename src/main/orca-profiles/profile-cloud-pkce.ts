import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import {
  ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS,
  ORCA_CLOUD_CALLBACK_SUCCESS_PAGE
} from './profile-cloud-callback-page'

export type OrcaCloudAuthorizationCode = {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  state: string
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function closeServer(server: Server): void {
  try {
    // Why: keep-alive sockets from the browser can delay 'close' (and the
    // timeout cleanup) until the browser drops the connection.
    server.closeAllConnections?.()
    server.close()
  } catch {
    // Already closed.
  }
}

export function beginOrcaCloudPkceFlow(
  config: OrcaCloudAuthConfig,
  localProfileId: string
): Promise<OrcaCloudAuthorizationCode> {
  const codeVerifier = createCodeVerifier()
  const nonce = base64Url(randomBytes(32))
  const state = base64Url(randomBytes(32))

  return new Promise((resolve, reject) => {
    let settled = false
    let redirectUri = ''

    function rejectFlow(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      reject(error)
      closeServer(server)
    }

    function resolveFlow(code: string): void {
      if (settled) {
        return
      }
      settled = true
      resolve({
        code,
        codeVerifier,
        nonce,
        redirectUri,
        state
      })
      closeServer(server)
    }

    function writeInvalidCallback(response: ServerResponse): void {
      response.writeHead(400)
      response.end('Invalid Orca sign-in response.')
    }

    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/auth/callback') {
          response.writeHead(404)
          response.end('Not found')
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        if (returnedState !== state) {
          // Why: stray loopback probes must not be able to cancel the user's login.
          writeInvalidCallback(response)
          return
        }
        if (url.searchParams.has('error')) {
          response.writeHead(400)
          response.end('Orca sign-in was cancelled.')
          rejectFlow(new Error('orca_cloud_auth_denied'))
          return
        }
        if (!code) {
          writeInvalidCallback(response)
          return
        }
        response.writeHead(200, ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS)
        response.end(ORCA_CLOUD_CALLBACK_SUCCESS_PAGE)
        resolveFlow(code)
      } catch (error) {
        rejectFlow(error instanceof Error ? error : new Error('orca_cloud_auth_callback_failed'))
      }
    })

    const timeout = setTimeout(() => {
      rejectFlow(new Error('orca_cloud_auth_timeout'))
    }, AUTH_TIMEOUT_MS)
    server.once('close', () => clearTimeout(timeout))
    server.once('error', rejectFlow)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectFlow(new Error('orca_cloud_auth_loopback_unavailable'))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const authorizeUrl = new URL(config.authorizeEndpoint)
      authorizeUrl.searchParams.set('client_id', config.clientId)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('scope', config.scope)
      authorizeUrl.searchParams.set('nonce', nonce)
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier))
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      authorizeUrl.searchParams.set('local_profile_id', localProfileId)
      void shell.openExternal(authorizeUrl.toString()).catch((error) => {
        rejectFlow(
          error instanceof Error ? error : new Error('orca_cloud_auth_browser_open_failed')
        )
      })
    })
  })
}
