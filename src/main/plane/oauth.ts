import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import { getInstanceTokenPath } from './storage-paths'
import { fetchPlaneViewer, instanceId, normalizeBaseUrl } from './api-request'
import { writeEncryptedCredential } from '../integration-credential-file'
import type { PlaneInstance, PlaneOAuthConnectArgs, PlaneViewer } from '../../shared/plane/types'

type InstanceFile = {
  version: 1
  activeInstanceId: string | null
  selectedInstanceId: string | null
  instances: PlaneInstance[]
}

type OAuthToken = { accessToken: string; refreshToken?: string; expiresAt?: number }

const SERVICE = 'Plane'
const DEFAULT_SCOPE = 'read write'

export async function connectOAuth(
  args: PlaneOAuthConnectArgs,
  storage: {
    getInstanceFile: () => InstanceFile
    writeInstanceFile: (file: InstanceFile) => void
    ensureDirs: () => void
    setToken: (id: string, token: string) => void
  }
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  try {
    const baseUrl = normalizeBaseUrl(args.baseUrl)
    const workspaceSlug = args.workspaceSlug.trim()
    const clientId = args.clientId.trim()
    const clientSecret = args.clientSecret.trim()
    if (!workspaceSlug || !clientId || !clientSecret) {
      return { ok: false, error: 'Workspace slug, client ID, and client secret are required' }
    }
    const { code, redirectUri } = await runOAuthCallback(baseUrl, clientId, args.scope)
    const token = await exchangeCode(baseUrl, { code, redirectUri, clientId, clientSecret })
    const id = instanceId(baseUrl, workspaceSlug)
    const viewer = await fetchPlaneViewer({
      instance: { id, baseUrl, workspaceSlug, authMode: 'oauth', displayName: workspaceSlug },
      auth: { kind: 'oauth', accessToken: token.accessToken }
    })
    const serialized = JSON.stringify(token)
    storage.ensureDirs()
    storage.setToken(id, serialized)
    writeEncryptedCredential(SERVICE, getInstanceTokenPath(id), serialized)
    const file = storage.getInstanceFile()
    const existing = file.instances.filter((instance) => instance.id !== id)
    storage.writeInstanceFile({
      version: 1,
      activeInstanceId: id,
      selectedInstanceId: id,
      instances: [
        {
          id,
          baseUrl,
          workspaceSlug,
          authMode: 'oauth',
          displayName: viewer.displayName || workspaceSlug,
          email: viewer.email ?? null,
          userId: viewer.id ?? null,
          credentialRevision: Date.now()
        },
        ...existing
      ]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function runOAuthCallback(
  baseUrl: string,
  clientId: string,
  scope = DEFAULT_SCOPE
): Promise<{ code: string; redirectUri: string }> {
  const state = randomBytes(24).toString('hex')
  const server = createServer()
  const port = await listen(server)
  const redirectUri = `http://127.0.0.1:${port}/plane/oauth/callback`
  const authUrl = new URL('/auth/o/authorize-app/', baseUrl)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', scope.trim() || DEFAULT_SCOPE)
  authUrl.searchParams.set('state', state)
  const result = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Plane OAuth timed out')), 120_000)
    server.on('request', (req, res) => {
      handleCallback(req, res, state, redirectUri, resolve, reject)
      clearTimeout(timeout)
      server.close()
    })
  })
  await shell.openExternal(authUrl.toString())
  return result
}

function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  state: string,
  redirectUri: string,
  resolve: (value: { code: string; redirectUri: string }) => void,
  reject: (error: Error) => void
): void {
  const url = new URL(req.url ?? '/', redirectUri)
  const code = url.searchParams.get('code')
  const receivedState = url.searchParams.get('state')
  if (url.pathname !== '/plane/oauth/callback' || !code || receivedState !== state) {
    res.writeHead(400).end('Plane OAuth failed. You can close this window.')
    reject(new Error('Plane OAuth callback was invalid'))
    return
  }
  res
    .writeHead(200, { 'Content-Type': 'text/plain' })
    .end('Plane connected. You can close this window.')
  resolve({ code, redirectUri })
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve(address.port)
        return
      }
      reject(new Error('No OAuth port'))
    })
  })
}

async function exchangeCode(
  baseUrl: string,
  args: { code: string; redirectUri: string; clientId: string; clientSecret: string }
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret
  })
  const response = await fetch(new URL('/auth/o/token/', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    throw new Error(`Plane OAuth token exchange failed: ${await response.text()}`.slice(0, 300))
  }
  const raw = (await response.json()) as Record<string, unknown>
  if (typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new Error('Plane OAuth token response did not include an access token')
  }
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : null
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
  }
}
