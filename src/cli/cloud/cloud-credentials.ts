// Private build only: where `orca cloud …` finds its control-plane credentials. Order:
//   1. ORCA_CLOUD_TOKEN (+ ORCA_CLOUD_API_URL) in the environment
//   2. ~/.config/orca-cloud/credentials.json ({apiUrl, token, workspaceId?}). Inside an Orca Cloud
//      VM the control plane writes this file at each boot with a workspace-scoped token; on a
//      desktop `orca cloud login` writes it (0600).
// The CLI talks HTTPS to the control plane directly, so it works with no Orca app running.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RuntimeClientError } from '../runtime/types'

export type CloudCredentialSource = 'env' | 'file'

export type CloudCredentials = {
  apiUrl: string
  token: string
  /** Set inside a VM: the workspace the token was minted for. */
  workspaceId: string | null
  source: CloudCredentialSource
  /** The credentials file, when that is where the token came from. */
  path: string | null
}

export type CloudCredentialEnv = Readonly<Record<string, string | undefined>>

export type CloudCredentialFs = {
  readFile: (path: string) => string | null
  writeFile: (path: string, contents: string) => void
  removeFile: (path: string) => boolean
}

export const nodeCloudCredentialFs: CloudCredentialFs = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  },
  writeFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    // Why: mode on create keeps the token unreadable to other users from the first byte.
    writeFileSync(tmp, contents, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  },
  removeFile: (path) => {
    try {
      rmSync(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
  }
}

export function cloudCredentialsPath(env: CloudCredentialEnv, home: string = homedir()): string {
  const override = env.ORCA_CLOUD_CREDENTIALS_FILE?.trim()
  return override ? override : join(home, '.config', 'orca-cloud', 'credentials.json')
}

const LOGIN_HINT =
  'Run `orca cloud login --token <token> --api-url <control-plane-url>`, or set ORCA_CLOUD_TOKEN and ORCA_CLOUD_API_URL.'
// Inside a VM the file only appears when the org allows it, so say why it may be missing.
const IN_VM_HINT =
  'Inside an Orca Cloud workspace the token is written at boot only when the organization has in-workspace CLI access turned on (Orca Cloud settings, vmCliEnabled).'

/**
 * Only https may carry the bearer token; plain http is allowed for loopback dev servers.
 * Returns the URL without a trailing slash.
 */
export function normalizeCloudApiUrl(raw: string, label: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new RuntimeClientError('invalid_argument', `${label} is not a valid URL: ${raw}`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${label} must be an https:// URL (http:// only for localhost).`
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${label} must be a plain origin URL without credentials, query or fragment.`
    )
  }
  return url.toString().replace(/\/+$/, '')
}

type CredentialsFile = { apiUrl?: unknown; token?: unknown; workspaceId?: unknown }

function readCredentialsFile(
  path: string,
  fs: CloudCredentialFs
): { apiUrl: string | null; token: string | null; workspaceId: string | null } | null {
  const raw = fs.readFile(path)
  if (raw === null) {
    return null
  }
  let parsed: CredentialsFile
  try {
    parsed = JSON.parse(raw) as CredentialsFile
  } catch {
    throw new RuntimeClientError('cloud_credentials_invalid', `${path} is not valid JSON.`, {
      path,
      nextSteps: [LOGIN_HINT]
    })
  }
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null
  return {
    apiUrl: str(parsed?.apiUrl),
    token: str(parsed?.token),
    workspaceId: str(parsed?.workspaceId)
  }
}

/** Resolves credentials or throws `cloud_not_signed_in` with the ways to provide them. */
export function resolveCloudCredentials(
  env: CloudCredentialEnv,
  options: { fs?: CloudCredentialFs; home?: string } = {}
): CloudCredentials {
  const fs = options.fs ?? nodeCloudCredentialFs
  const path = cloudCredentialsPath(env, options.home)
  const envToken = env.ORCA_CLOUD_TOKEN?.trim()
  if (envToken) {
    // The URL may come from the env, the desktop's control-plane setting or the credentials file.
    const envUrl = env.ORCA_CLOUD_API_URL?.trim() || env.ORCA_CLOUD_SANDBOX_URL?.trim()
    const fileUrl = envUrl ? null : readCredentialsFile(path, fs)?.apiUrl
    const apiUrl = envUrl || fileUrl
    if (!apiUrl) {
      throw new RuntimeClientError(
        'cloud_not_signed_in',
        'ORCA_CLOUD_TOKEN is set but no control-plane URL is: set ORCA_CLOUD_API_URL too.',
        { nextSteps: ['export ORCA_CLOUD_API_URL=https://<control-plane-host>'] }
      )
    }
    return {
      apiUrl: normalizeCloudApiUrl(apiUrl, envUrl ? 'ORCA_CLOUD_API_URL' : `apiUrl in ${path}`),
      token: envToken,
      workspaceId: env.ORCA_CLOUD_WORKSPACE_ID?.trim() || null,
      source: 'env',
      path: null
    }
  }
  const file = readCredentialsFile(path, fs)
  if (!file || !file.token) {
    throw new RuntimeClientError(
      'cloud_not_signed_in',
      file ? `${path} has no token.` : 'Not signed in to Orca Cloud.',
      { path, nextSteps: [LOGIN_HINT, IN_VM_HINT] }
    )
  }
  const apiUrl = env.ORCA_CLOUD_API_URL?.trim() || file.apiUrl
  if (!apiUrl) {
    throw new RuntimeClientError('cloud_credentials_invalid', `${path} has no apiUrl.`, {
      path,
      nextSteps: [LOGIN_HINT]
    })
  }
  return {
    apiUrl: normalizeCloudApiUrl(
      apiUrl,
      env.ORCA_CLOUD_API_URL?.trim() ? 'ORCA_CLOUD_API_URL' : `apiUrl in ${path}`
    ),
    token: file.token,
    workspaceId: file.workspaceId,
    source: 'file',
    path
  }
}

export function writeCloudCredentials(
  env: CloudCredentialEnv,
  value: { apiUrl: string; token: string; workspaceId?: string | null },
  options: { fs?: CloudCredentialFs; home?: string } = {}
): string {
  const fs = options.fs ?? nodeCloudCredentialFs
  const path = cloudCredentialsPath(env, options.home)
  fs.writeFile(
    path,
    `${JSON.stringify({
      apiUrl: value.apiUrl,
      token: value.token,
      ...(value.workspaceId ? { workspaceId: value.workspaceId } : {})
    })}\n`
  )
  return path
}

export function removeCloudCredentials(
  env: CloudCredentialEnv,
  options: { fs?: CloudCredentialFs; home?: string } = {}
): { path: string; removed: boolean } {
  const fs = options.fs ?? nodeCloudCredentialFs
  const path = cloudCredentialsPath(env, options.home)
  return { path, removed: fs.removeFile(path) }
}

/** Shown in whoami/errors; never more than a prefix of the secret. */
export function describeCloudToken(token: string): string {
  if (token.startsWith('orca_ws_')) {
    return 'workspace token'
  }
  if (token.startsWith('orca_')) {
    return 'API key'
  }
  return 'session token'
}
