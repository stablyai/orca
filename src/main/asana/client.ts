/* eslint-disable max-lines -- Why: Asana credential storage and authenticated
request plumbing share one boundary so encrypted token lifecycle and
multi-workspace selection cannot drift between task operations. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeStorage } from 'electron'
import type {
  AsanaConnectArgs,
  AsanaConnectionStatus,
  AsanaViewer,
  AsanaWorkspace,
  AsanaWorkspaceSelection
} from '../../shared/types'

// Why: Asana's REST base is fixed (unlike Jira's per-site host), so clients
// only carry the bearer token; every request targets this origin.
export const ASANA_API_BASE = 'https://app.asana.com/api/1.0'

const MAX_CONCURRENT = 4
// Why: every Asana call funnels through the shared fetch helpers; without a
// timeout a stalled socket hangs the main-process operation indefinitely.
const ASANA_REQUEST_TIMEOUT_MS = 30_000
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

type AsanaWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: AsanaWorkspaceSelection | null
  workspaces: AsanaWorkspace[]
}

export type AsanaClientForWorkspace = {
  workspace: AsanaWorkspace
  authorization: string
}

export class AsanaApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

let cachedWorkspaceFile: AsanaWorkspaceFile | null = null
let workspaceFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: Asana exposes no API to detect a workspace's plan tier — the premium
// search endpoint must be probed and returns 402 on free tiers. Remember that
// once per workspace so repeat searches skip the doomed call and go straight to
// the local-filter fallback. Reset whenever connection state changes.
const searchUnavailableWorkspaces = new Set<string>()

export function markSearchUnavailable(workspaceId: string): void {
  searchUnavailableWorkspaces.add(workspaceId)
}

export function isSearchUnavailable(workspaceId: string): boolean {
  return searchUnavailableWorkspaces.has(workspaceId)
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'asana-workspaces.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'asana-tokens')
}

function getTokenPath(workspaceId: string): string {
  return join(getTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyWorkspaceFile(): AsanaWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

function hasStoredToken(workspaceId: string): boolean {
  return cachedTokens.has(workspaceId) || existsSync(getTokenPath(workspaceId))
}

function normalizeWorkspace(input: unknown): AsanaWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.userGid !== 'string' ||
    typeof record.userName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    userGid: record.userGid,
    userName: record.userName,
    userEmail: typeof record.userEmail === 'string' ? record.userEmail : null
  }
}

function readWorkspaceFileFromDisk(): AsanaWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<AsanaWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is AsanaWorkspace => workspace !== null)
          .filter((workspace) => hasStoredToken(workspace.id))
      : []
    const activeWorkspaceId =
      typeof parsed.activeWorkspaceId === 'string' &&
      workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : (workspaces[0]?.id ?? null)
    const selectedWorkspaceId =
      parsed.selectedWorkspaceId === 'all' ||
      (typeof parsed.selectedWorkspaceId === 'string' &&
        workspaces.some((workspace) => workspace.id === parsed.selectedWorkspaceId))
        ? parsed.selectedWorkspaceId
        : activeWorkspaceId
    return { version: 1, activeWorkspaceId, selectedWorkspaceId, workspaces }
  } catch {
    return emptyWorkspaceFile()
  }
}

function getWorkspaceFile(): AsanaWorkspaceFile {
  if (!workspaceFileLoaded || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoaded = true
  }
  return cachedWorkspaceFile
}

function writeWorkspaceFile(file: AsanaWorkspaceFile): void {
  ensureOrcaDir()
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const activeWorkspaceId =
    file.activeWorkspaceId &&
    workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (workspaces[0]?.id ?? null)
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId &&
          workspaces.some((workspace) => workspace.id === file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  cachedWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
  workspaceFileLoaded = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

// Why: persist the on-disk format alongside the bytes so reads don't depend on
// the *current* safeStorage availability. If that flips between write and read,
// a marker-less heuristic would decrypt plaintext as garbage (or vice versa).
const TOKEN_ENC_PREFIX = 'asana-token:v1:enc\n'
const TOKEN_PLAIN_PREFIX = 'asana-token:v1:plain\n'

function writeEncryptedToken(path: string, apiToken: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiToken)
    writeFileSync(path, Buffer.concat([Buffer.from(TOKEN_ENC_PREFIX), encrypted]), { mode: 0o600 })
    return
  }
  console.warn('[asana] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, `${TOKEN_PLAIN_PREFIX}${apiToken}`, { encoding: 'utf-8', mode: 0o600 })
}

function decodeStoredToken(raw: Buffer): string | null {
  const header = raw.subarray(0, 32).toString('utf-8')
  if (header.startsWith(TOKEN_ENC_PREFIX)) {
    // Encrypted on disk but no key available now — credentials are unreadable.
    if (!safeStorage.isEncryptionAvailable()) {
      return null
    }
    return safeStorage.decryptString(raw.subarray(Buffer.byteLength(TOKEN_ENC_PREFIX)))
  }
  if (header.startsWith(TOKEN_PLAIN_PREFIX)) {
    return raw.subarray(Buffer.byteLength(TOKEN_PLAIN_PREFIX)).toString('utf-8')
  }
  // Legacy token without a format marker — fall back to the prior heuristic.
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(raw)
    : raw.toString('utf-8')
}

function readToken(workspaceId: string): string | null {
  const cached = cachedTokens.get(workspaceId)
  if (cached) {
    return cached
  }
  const path = getTokenPath(workspaceId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = decodeStoredToken(readFileSync(path))
    if (token === null) {
      return null
    }
    cachedTokens.set(workspaceId, token)
    return token
  } catch {
    return null
  }
}

function saveToken(workspaceId: string, apiToken: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(workspaceId), apiToken)
  cachedTokens.set(workspaceId, apiToken)
}

function deleteToken(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  try {
    unlinkSync(getTokenPath(workspaceId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

function workspaceToViewer(workspace: AsanaWorkspace | null): AsanaViewer | null {
  if (!workspace) {
    return null
  }
  return {
    gid: workspace.userGid,
    name: workspace.userName,
    email: workspace.userEmail
  }
}

function authHeader(apiToken: string): string {
  return `Bearer ${apiToken}`
}

type AsanaMeResponse = {
  data?: {
    gid?: string
    name?: string
    email?: string
    workspaces?: { gid?: string; name?: string }[]
  }
}

async function readAsanaError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      errors?: { message?: string }[]
    }
    const messages = (data.errors ?? [])
      .map((error) => error.message)
      .filter((message): message is string => Boolean(message))
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Asana request failed (${response.status})`
}

async function requestWithToken(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', authHeader(apiToken))
  const response = await fetch(`${ASANA_API_BASE}${path}`, {
    signal: AbortSignal.timeout(ASANA_REQUEST_TIMEOUT_MS),
    ...init,
    headers
  })
  if (!response.ok) {
    throw new AsanaApiError(await readAsanaError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

export async function asanaRequest<T>(
  client: AsanaClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', client.authorization)
  const response = await fetch(`${ASANA_API_BASE}${path}`, {
    signal: AbortSignal.timeout(ASANA_REQUEST_TIMEOUT_MS),
    ...init,
    headers
  })
  if (!response.ok) {
    throw new AsanaApiError(await readAsanaError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}

export function getClients(selection?: AsanaWorkspaceSelection | null): AsanaClientForWorkspace[] {
  const file = getWorkspaceFile()
  const selected = selection ?? file.selectedWorkspaceId ?? file.activeWorkspaceId
  const workspaces =
    selected === 'all'
      ? file.workspaces
      : file.workspaces.filter((workspace) => workspace.id === (selected ?? file.activeWorkspaceId))

  return workspaces.flatMap((workspace) => {
    const token = readToken(workspace.id)
    return token ? [{ workspace, authorization: authHeader(token) }] : []
  })
}

export function getStatus(): AsanaConnectionStatus {
  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === file.activeWorkspaceId) ?? workspaces[0] ?? null
  return {
    connected: workspaces.length > 0,
    viewer: workspaceToViewer(activeWorkspace),
    workspaces,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    selectedWorkspaceId: file.selectedWorkspaceId ?? activeWorkspace?.id ?? null
  }
}

function toWorkspaces(me: AsanaMeResponse['data']): AsanaWorkspace[] {
  const userGid = typeof me?.gid === 'string' ? me.gid : ''
  const userName = typeof me?.name === 'string' ? me.name : 'Asana user'
  const userEmail = typeof me?.email === 'string' ? me.email : null
  const workspaces = Array.isArray(me?.workspaces) ? me.workspaces : []
  return workspaces
    .filter(
      (workspace): workspace is { gid: string; name?: string } => typeof workspace?.gid === 'string'
    )
    .map((workspace) => ({
      id: workspace.gid,
      name: typeof workspace.name === 'string' ? workspace.name : 'Workspace',
      userGid,
      userName,
      userEmail
    }))
}

export async function connect(
  args: AsanaConnectArgs
): Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }> {
  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'A Personal Access Token is required.' }
  }

  await acquire()
  try {
    const response = (await requestWithToken(
      apiToken,
      '/users/me?opt_fields=name,email,workspaces.name'
    )) as AsanaMeResponse
    const workspaces = toWorkspaces(response.data)
    if (workspaces.length === 0) {
      return { ok: false, error: 'This token has no accessible Asana workspaces.' }
    }
    // Why: a single PAT authenticates every workspace, so we persist the same
    // token under each workspace id to keep the per-workspace selection model
    // identical to Jira's per-site storage.
    for (const workspace of workspaces) {
      saveToken(workspace.id, apiToken)
    }
    // Why: a new PAT may belong to a different plan tier, so forget any prior
    // "search unavailable" verdict and let the next search re-probe.
    searchUnavailableWorkspaces.clear()
    const file = getWorkspaceFile()
    const newIds = new Set(workspaces.map((workspace) => workspace.id))
    writeWorkspaceFile({
      version: 1,
      activeWorkspaceId: workspaces[0].id,
      selectedWorkspaceId: workspaces[0].id,
      workspaces: [...workspaces, ...file.workspaces.filter((entry) => !newIds.has(entry.id))]
    })
    return { ok: true, viewer: workspaceToViewer(workspaces[0])! }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(workspaceId?: string): void {
  const file = getWorkspaceFile()
  const ids = workspaceId ? [workspaceId] : file.workspaces.map((workspace) => workspace.id)
  for (const id of ids) {
    deleteToken(id)
    searchUnavailableWorkspaces.delete(id)
  }
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: file.activeWorkspaceId,
    selectedWorkspaceId: file.selectedWorkspaceId,
    workspaces: file.workspaces.filter((workspace) => !ids.includes(workspace.id))
  })
}

export function selectWorkspace(workspaceId: AsanaWorkspaceSelection): AsanaConnectionStatus {
  const file = getWorkspaceFile()
  if (workspaceId !== 'all' && !file.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return getStatus()
  }
  writeWorkspaceFile({
    ...file,
    activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId
  })
  return getStatus()
}

export async function testConnection(
  workspaceId?: string
): Promise<{ ok: true; viewer: AsanaViewer } | { ok: false; error: string }> {
  const client = getClients(workspaceId)[0]
  if (!client) {
    return { ok: false, error: 'Not connected to Asana.' }
  }
  await acquire()
  try {
    const response = (await asanaRequest(
      client,
      '/users/me?opt_fields=name,email'
    )) as AsanaMeResponse
    return {
      ok: true,
      viewer: {
        gid: typeof response.data?.gid === 'string' ? response.data.gid : client.workspace.userGid,
        name:
          typeof response.data?.name === 'string' ? response.data.name : client.workspace.userName,
        email:
          typeof response.data?.email === 'string'
            ? response.data.email
            : client.workspace.userEmail
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(workspaceId: string): void {
  deleteToken(workspaceId)
  searchUnavailableWorkspaces.delete(workspaceId)
  const file = getWorkspaceFile()
  writeWorkspaceFile({
    ...file,
    workspaces: file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  })
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AsanaApiError && (error.status === 401 || error.status === 403)
}
