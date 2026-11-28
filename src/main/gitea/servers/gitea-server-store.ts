import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { credentialFileExists, inCredentialFileOrder } from '../../credentials/credential-file-io'
import {
  CredentialDecryptionError,
  writeEncryptedCredential
} from '../../credentials/integration-credential-file'
import { createIntegrationStateFileCache } from '../../credentials/integration-state-file-cache'
import { createIntegrationTokenFileCache } from '../../credentials/integration-token-file-cache'
import { giteaApiBelongsToRepoHost, validateGiteaApiUrl } from '../requests/gitea-api-url'
import type { GiteaServer } from '../../../shared/gitea/gitea-types'

// Server metadata in one JSON file and one encrypted token per server, like Jira sites.
export type GiteaServerFile = {
  version: 1
  servers: GiteaServer[]
}

export type GiteaServerToken = {
  server: GiteaServer
  token: string
}

const serverFileCache = createIntegrationStateFileCache({
  filePath: getServerFilePath,
  readFromDisk: readServerFileFromDisk
})
const tokenFileCache = createIntegrationTokenFileCache({ service: 'Gitea', filePath: getTokenPath })

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = validateGiteaApiUrl(value)
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

export function deriveGiteaWebBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/v1$/i, '')
}

export function giteaServerHost(server: Pick<GiteaServer, 'apiBaseUrl'>): string | null {
  try {
    return new URL(server.apiBaseUrl).host.toLowerCase()
  } catch {
    return null
  }
}

export function getGiteaServerId(apiBaseUrl: string): string {
  return createHash('sha256').update(apiBaseUrl).digest('base64url').slice(0, 24)
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getServerFilePath(): string {
  return join(getOrcaDir(), 'gitea-servers.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'gitea-tokens')
}

function getTokenPath(serverId: string): string {
  return join(getTokenDir(), `${Buffer.from(serverId).toString('base64url')}.enc`)
}

async function ensureDir(dir: string): Promise<void> {
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

function emptyServerFile(): GiteaServerFile {
  return { version: 1, servers: [] }
}

export async function hasStoredToken(serverId: string): Promise<boolean> {
  return tokenFileCache.has(serverId)
}

const serverSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    baseUrl: z.string(),
    apiBaseUrl: z.string(),
    displayName: z.string(),
    account: z.string().nullable().optional()
  })
)

function normalizeServer(input: unknown): GiteaServer | null {
  const parsed = serverSchema.safeParse(input)
  return parsed.success ? { ...parsed.data, account: parsed.data.account ?? null } : null
}

async function readServerFileFromDisk(): Promise<GiteaServerFile> {
  const path = getServerFilePath()
  if (!(await credentialFileExists(path))) {
    return emptyServerFile()
  }
  try {
    const parsed = z
      .object({ servers: z.array(z.unknown()).optional() })
      .parse(JSON.parse(await readFile(path, { encoding: 'utf-8' })))
    const servers = (parsed.servers ?? [])
      .map((server) => normalizeServer(server))
      .filter((server): server is GiteaServer => server !== null)
    return { version: 1, servers }
  } catch {
    return emptyServerFile()
  }
}

// Drops servers whose token file is gone.
async function selectableServerFile(file: GiteaServerFile): Promise<GiteaServerFile> {
  const presence = await Promise.all(file.servers.map((server) => hasStoredToken(server.id)))
  return { version: 1, servers: file.servers.filter((_, index) => presence[index]) }
}

export async function getServerFile(): Promise<GiteaServerFile> {
  const file = await inCredentialFileOrder(getServerFilePath(), () => serverFileCache.get())
  return selectableServerFile(file)
}

export async function writeServerFile(file: GiteaServerFile): Promise<void> {
  return inCredentialFileOrder(getServerFilePath(), async () => {
    await ensureDir(getOrcaDir())
    const next = await selectableServerFile(file)
    await writeFile(getServerFilePath(), JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    serverFileCache.invalidate()
  })
}

export async function readToken(serverId: string): Promise<string | null> {
  return tokenFileCache.read(serverId)
}

export async function saveToken(serverId: string, token: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(serverId)}.mutation`, async () => {
    await ensureDir(getOrcaDir())
    await ensureDir(getTokenDir())
    await writeEncryptedCredential('Gitea', getTokenPath(serverId), token)
    tokenFileCache.forget(serverId)
  })
}

export async function deleteToken(serverId: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(serverId)}.mutation`, async () => {
    tokenFileCache.forget(serverId)
    try {
      await unlink(getTokenPath(serverId))
    } catch {}
  })
}

export async function getCredentialError(
  serverIds: readonly string[]
): Promise<string | undefined> {
  const errors = await Promise.all(serverIds.map((id) => tokenFileCache.error(id)))
  return errors.find((message) => message !== undefined)
}

export function inServerRegistryOrder<T>(run: () => Promise<T>): Promise<T> {
  return inCredentialFileOrder(`${getServerFilePath()}.registry`, run)
}

/** The stored server and token for a repo remote host, or null when none is connected. */
export async function getServerForHost(
  host: string | null | undefined
): Promise<GiteaServerToken | null> {
  if (!host) {
    return null
  }
  const normalizedHost = host.toLowerCase()
  const file = await getServerFile()
  // An exact authority wins; a port-less (SSH) remote falls back to the server on the same hostname.
  const server =
    file.servers.find((entry) => giteaServerHost(entry) === normalizedHost) ??
    file.servers.find((entry) => giteaApiBelongsToRepoHost(entry.apiBaseUrl, normalizedHost))
  if (!server) {
    return null
  }
  let token: string | null
  try {
    token = await readToken(server.id)
  } catch {
    // The decrypt failure is kept per server and surfaced through status.
    return null
  }
  return token ? { server, token } : null
}

/** Connected servers and tokens; one named server rethrows a decrypt failure, all servers skip it. */
export async function getServerTokens(serverId?: string): Promise<GiteaServerToken[]> {
  const file = await getServerFile()
  const isAllSelection = serverId === undefined
  const servers = isAllSelection
    ? file.servers
    : file.servers.filter((server) => server.id === serverId)
  const tokens = await Promise.all(
    servers.map(async (server) => {
      try {
        const token = await readToken(server.id)
        return token ? { server, token } : null
      } catch (error) {
        if (isAllSelection && error instanceof CredentialDecryptionError) {
          return null
        }
        throw error
      }
    })
  )
  return tokens.filter((entry): entry is GiteaServerToken => entry !== null)
}

export function _resetGiteaServerStoreForTest(): void {
  serverFileCache.invalidate()
  tokenFileCache.clear()
}
