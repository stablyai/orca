/* eslint-disable max-lines -- Why: Huly credential storage and client
   selection share one module so keychain-safe status reads and token mutation
   stay in one consistency boundary. */
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import type {
  HulyConnection,
  HulyConnectionSelection,
  HulyConnectionStatus,
  HulyViewer
} from '../../shared/types'
import { preflightHulyCli } from './huly-cli'

// ── Concurrency limiter — max 4 parallel huly CLI calls ───────────────
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

// ── Storage layout ────────────────────────────────────────────────────
// Why: tokens stay encrypted via safeStorage; metadata stays plaintext so
// status checks render connected accounts without decrypting or triggering
// OS keychain prompts after app updates.
type HulyConnectionsFile = {
  version: 1
  activeConnectionId: string | null
  selectedConnectionId: HulyConnectionSelection | null
  connections: HulyConnection[]
}

let cachedSecrets = new Map<string, string>()
const credentialErrors = new Map<string, string>()
let cachedConnectionsFile: HulyConnectionsFile | null = null
let connectionsFileLoadedFromDisk = false
let preflightCache: {
  at: number
  status: { installed: boolean; authenticated: boolean; cliVersion?: string }
} | null = null
const PREFLIGHT_TTL_MS = 30_000

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getConnectionsFilePath(): string {
  return join(getOrcaDir(), 'huly-connections.json')
}

function getConnectionsDir(): string {
  return join(getOrcaDir(), 'huly-connections')
}

function getConnectionSecretPath(connectionId: string): string {
  return join(getConnectionsDir(), `${Buffer.from(connectionId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureConnectionsDir(): void {
  const dir = getConnectionsDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function normalizeConnection(input: unknown): HulyConnection | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.url !== 'string' ||
    typeof record.workspace !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    workspace: record.workspace,
    email: typeof record.email === 'string' ? record.email : null,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    credentialRevision:
      typeof record.credentialRevision === 'number' && Number.isFinite(record.credentialRevision)
        ? record.credentialRevision
        : undefined
  }
}

function emptyConnectionsFile(): HulyConnectionsFile {
  return {
    version: 1,
    activeConnectionId: null,
    selectedConnectionId: null,
    connections: []
  }
}

function readConnectionsFileFromDisk(): HulyConnectionsFile {
  const path = getConnectionsFilePath()
  if (!existsSync(path)) {
    return emptyConnectionsFile()
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<HulyConnectionsFile>
    const connections = Array.isArray(parsed.connections)
      ? parsed.connections
          .map((connection) => normalizeConnection(connection))
          .filter((connection): connection is HulyConnection => connection !== null)
          .filter((connection) => hasStoredSecret(connection.id))
      : []
    const activeConnectionId =
      typeof parsed.activeConnectionId === 'string' &&
      connections.some((connection) => connection.id === parsed.activeConnectionId)
        ? parsed.activeConnectionId
        : (connections[0]?.id ?? null)
    const selectedConnectionId =
      parsed.selectedConnectionId === 'all' ||
      (typeof parsed.selectedConnectionId === 'string' &&
        connections.some((connection) => connection.id === parsed.selectedConnectionId))
        ? parsed.selectedConnectionId
        : activeConnectionId
    return {
      version: 1,
      activeConnectionId,
      selectedConnectionId,
      connections
    }
  } catch {
    return emptyConnectionsFile()
  }
}

// Why: each connection owns one token file; metadata describes the connection
// but does not contain the secret. Multi-connection is required because users
// can host multiple Huly instances.
function getConnectionsFile(): HulyConnectionsFile {
  if (!connectionsFileLoadedFromDisk || !cachedConnectionsFile) {
    cachedConnectionsFile = readConnectionsFileFromDisk()
    connectionsFileLoadedFromDisk = true
  }
  return cachedConnectionsFile
}

function writeConnectionsFile(file: HulyConnectionsFile): void {
  ensureOrcaDir()
  cachedConnectionsFile = file
  connectionsFileLoadedFromDisk = true
  writeFileSync(getConnectionsFilePath(), JSON.stringify(file, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function hasStoredSecret(connectionId: string): boolean {
  if (cachedSecrets.has(connectionId)) {
    return true
  }
  return credentialFileHasContent(getConnectionSecretPath(connectionId))
}

function writeEncryptedSecret(path: string, secret: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(secret)
    writeFileSync(path, encrypted, { mode: 0o600 })
    return
  }
  console.warn('[huly] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, secret, { encoding: 'utf-8', mode: 0o600 })
}

function saveConnectionSecret(connectionId: string, secret: string): void {
  ensureOrcaDir()
  ensureConnectionsDir()
  writeEncryptedSecret(getConnectionSecretPath(connectionId), secret)
  cachedSecrets.set(connectionId, secret)
  credentialErrors.delete(connectionId)
}

export function loadSecret(connectionId: string, options: { force?: boolean } = {}): string | null {
  if (!connectionId) {
    return null
  }
  const cached = cachedSecrets.get(connectionId)
  if (cached !== undefined) {
    return cached
  }
  if (!options.force) {
    return null
  }
  const path = getConnectionSecretPath(connectionId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Huly', raw)
    if (token) {
      cachedSecrets.set(connectionId, token)
    }
    credentialErrors.delete(connectionId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(connectionId, error.message)
      throw error
    }
    return null
  }
}

function clearSecretFile(connectionId: string): void {
  cachedSecrets.delete(connectionId)
  credentialErrors.delete(connectionId)
  try {
    unlinkSync(getConnectionSecretPath(connectionId))
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function clearSecret(connectionId?: string): void {
  if (!connectionId) {
    const file = getConnectionsFile()
    for (const connection of file.connections) {
      clearSecretFile(connection.id)
    }
    cachedSecrets = new Map()
    credentialErrors.clear()
    writeConnectionsFile(emptyConnectionsFile())
    return
  }
  clearSecretFile(connectionId)
  const file = getConnectionsFile()
  const remaining = file.connections.filter((connection) => connection.id !== connectionId)
  const activeConnectionId =
    file.activeConnectionId === connectionId ? (remaining[0]?.id ?? null) : file.activeConnectionId
  const selectedConnectionId =
    file.selectedConnectionId === connectionId ? activeConnectionId : file.selectedConnectionId
  writeConnectionsFile({
    version: 1,
    activeConnectionId,
    selectedConnectionId,
    connections: remaining
  })
}

function resolveConnectionId(connectionId?: string | null): string | null {
  if (connectionId && connectionId !== 'all') {
    return connectionId
  }
  const file = getConnectionsFile()
  if (
    file.selectedConnectionId &&
    file.selectedConnectionId !== 'all' &&
    file.connections.some((connection) => connection.id === file.selectedConnectionId)
  ) {
    return file.selectedConnectionId
  }
  if (
    file.activeConnectionId &&
    file.connections.some((connection) => connection.id === file.activeConnectionId)
  ) {
    return file.activeConnectionId
  }
  return file.connections[0]?.id ?? null
}

export function getConnection(connectionId?: string | null): HulyConnection | null {
  const id = resolveConnectionId(connectionId)
  if (!id) {
    return null
  }
  return getConnectionsFile().connections.find((connection) => connection.id === id) ?? null
}

export function getAllConnections(): HulyConnection[] {
  return getConnectionsFile().connections.filter((connection) => hasStoredSecret(connection.id))
}

function upsertConnection(connection: HulyConnection, options: { select?: boolean } = {}): void {
  const file = getConnectionsFile()
  const current = file.connections.find((entry) => entry.id === connection.id)
  const credentialRevision = (current?.credentialRevision ?? 0) + 1
  const next = { ...connection, credentialRevision }
  const withoutCurrent = file.connections.filter((entry) => entry.id !== connection.id)
  const connections = [...withoutCurrent, next].sort((a, b) => a.name.localeCompare(b.name))
  const selectedConnectionId = options.select
    ? connection.id
    : (file.selectedConnectionId ?? connection.id)
  writeConnectionsFile({
    version: 1,
    activeConnectionId: connection.id,
    selectedConnectionId,
    connections
  })
}

export async function getPreflightStatus(): Promise<{
  installed: boolean
  authenticated: boolean
  cliVersion?: string
}> {
  if (preflightCache && Date.now() - preflightCache.at < PREFLIGHT_TTL_MS) {
    return preflightCache.status
  }
  const result = await preflightHulyCli()
  const status = {
    installed: result.installed,
    authenticated: result.authenticated,
    cliVersion: result.version
  }
  preflightCache = { at: Date.now(), status }
  return status
}

export function resetPreflightCache(): void {
  preflightCache = null
}

export type HulyConnectResult =
  | { ok: true; connection: HulyConnection; viewer: HulyViewer }
  | { ok: false; error: string }

export async function connect(input: {
  name: string
  url: string
  workspace: string
  email: string | null
  secret: string
  token?: string | null
}): Promise<HulyConnectResult> {
  // Why: validate credentials with `huly whoami` before persisting so a typo
  // in URL/workspace/secret surfaces immediately instead of failing later
  // issue/project calls.
  const id = `huly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const connection: HulyConnection = {
    id,
    name: input.name,
    url: input.url,
    workspace: input.workspace,
    email: input.email
  }
  const probeConnection: HulyConnection = { ...connection }
  let viewer: HulyViewer
  try {
    viewer = await probeViewer(probeConnection, input.secret, input.token ?? null)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Huly connect failed' }
  }
  saveConnectionSecret(id, input.secret)
  upsertConnection(connection, { select: true })
  resetPreflightCache()
  return { ok: true, connection, viewer }
}

async function probeViewer(
  connection: HulyConnection,
  secret: string,
  token: string | null
): Promise<HulyViewer> {
  const { runHulyCli, HulyCliMissingError, HulyCliAuthError } = await import('./huly-cli')
  try {
    const raw = await runHulyCli<RawViewer>(connection, token ? null : secret, token, ['whoami'])
    return {
      displayName: raw.displayName ?? connection.email ?? connection.name,
      email: raw.email ?? connection.email ?? null,
      workspaceName: raw.workspaceName ?? connection.workspace
    }
  } catch (error) {
    if (error instanceof HulyCliAuthError) {
      throw new Error('Huly rejected the credential. Check the URL, workspace, and token.')
    }
    if (error instanceof HulyCliMissingError) {
      throw new Error(
        'The `huly` CLI is not installed. Install it with `npm i -g @iamcoder18/huly-cli`.'
      )
    }
    throw error
  }
}

type RawViewer = {
  displayName?: string
  email?: string | null
  workspaceName?: string
}

export function disconnect(connectionId?: string): void {
  clearSecret(connectionId)
  resetPreflightCache()
}

export function selectConnection(connectionId: HulyConnectionSelection): HulyConnectionStatus {
  const file = getConnectionsFile()
  if (
    connectionId !== 'all' &&
    !file.connections.some((connection) => connection.id === connectionId)
  ) {
    return getStatus()
  }
  writeConnectionsFile({
    version: 1,
    activeConnectionId: connectionId === 'all' ? file.activeConnectionId : connectionId,
    selectedConnectionId: connectionId,
    connections: file.connections
  })
  return getStatus()
}

export function getStatus(): HulyConnectionStatus {
  const file = getConnectionsFile()
  const selected =
    file.selectedConnectionId && file.selectedConnectionId !== 'all'
      ? file.connections.find((connection) => connection.id === file.selectedConnectionId)
      : null
  const active =
    selected ??
    file.connections.find((connection) => connection.id === file.activeConnectionId) ??
    file.connections[0] ??
    null
  const credentialError = file.connections
    .map((connection) => credentialErrors.get(connection.id))
    .find((message) => message !== undefined)
  const preflight = preflightCache?.status
  return {
    connected: file.connections.length > 0,
    viewer: active
      ? {
          displayName: active.displayName ?? active.name,
          email: active.email,
          workspaceName: active.workspace
        }
      : null,
    connections: file.connections,
    activeConnectionId: file.activeConnectionId,
    selectedConnectionId: file.selectedConnectionId,
    cliInstalled: preflight?.installed ?? false,
    cliAuthenticated: preflight?.authenticated ?? false,
    cliVersion: preflight?.cliVersion,
    ...(credentialError ? { credentialError } : {})
  }
}

export function getSecret(connectionId?: string | null): string | null {
  const id = resolveConnectionId(connectionId)
  if (!id) {
    return null
  }
  return loadSecret(id, { force: true })
}

export function isAuthError(error: unknown): boolean {
  return error instanceof Error && error.name === 'HulyCliAuthError'
}

export function initHulyToken(): void {
  getConnectionsFile()
}
