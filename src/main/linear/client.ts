/* eslint-disable max-lines -- Why: Linear credential storage and client
   selection share one module so keychain-safe status reads and token mutation
   stay in one consistency boundary. */
import { safeStorage } from 'electron'
import { LinearClient, AuthenticationLinearError } from '@linear/sdk'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../shared/types'

// ── Concurrency limiter — max 4 parallel Linear API calls ────────────
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

// ── Token + workspace storage ────────────────────────────────────────
// Why: tokens remain encrypted via safeStorage, while workspace metadata stays
// plaintext so status checks can render connected accounts without decrypting
// and triggering OS keychain prompts after app updates.
const LEGACY_WORKSPACE_ID = 'legacy'

type LinearWorkspaceFile = {
  version: 1
  activeWorkspaceId: string | null
  selectedWorkspaceId: LinearWorkspaceSelection | null
  workspaces: LinearWorkspace[]
}

export type LinearClientForWorkspace = {
  workspace: LinearWorkspace
  client: LinearClient
}

let cachedTokens = new Map<string, string>()
let cachedLegacyViewer: LinearViewer | null = null
let legacyViewerLoadedFromDisk = false
let cachedWorkspaceFile: LinearWorkspaceFile | null = null
let workspaceFileLoadedFromDisk = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getLegacyTokenPath(): string {
  return join(getOrcaDir(), 'linear-token.enc')
}

function getLegacyViewerPath(): string {
  return join(getOrcaDir(), 'linear-viewer.json')
}

function getWorkspaceFilePath(): string {
  return join(getOrcaDir(), 'linear-workspaces.json')
}

function getWorkspaceTokenDir(): string {
  return join(getOrcaDir(), 'linear-tokens')
}

function getWorkspaceTokenPath(workspaceId: string): string {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return getLegacyTokenPath()
  }
  return join(getWorkspaceTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureWorkspaceTokenDir(): void {
  const dir = getWorkspaceTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function readLegacyViewerFromDisk(): LinearViewer | null {
  const path = getLegacyViewerPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearViewer>
    if (typeof parsed?.displayName !== 'string' || typeof parsed?.organizationName !== 'string') {
      return null
    }
    return {
      displayName: parsed.displayName,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      organizationId: typeof parsed.organizationId === 'string' ? parsed.organizationId : undefined,
      organizationName: parsed.organizationName,
      organizationUrlKey:
        typeof parsed.organizationUrlKey === 'string' ? parsed.organizationUrlKey : undefined
    }
  } catch {
    return null
  }
}

function getLegacyViewer(): LinearViewer | null {
  if (!legacyViewerLoadedFromDisk) {
    cachedLegacyViewer = readLegacyViewerFromDisk()
    legacyViewerLoadedFromDisk = true
  }
  return cachedLegacyViewer
}

function normalizeWorkspace(input: unknown): LinearWorkspace | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.organizationName !== 'string') {
    return null
  }
  if (typeof record.displayName !== 'string') {
    return null
  }

  const organizationId =
    typeof record.organizationId === 'string' && record.organizationId
      ? record.organizationId
      : record.id

  return {
    id: record.id,
    organizationId,
    organizationName: record.organizationName,
    organizationUrlKey:
      typeof record.organizationUrlKey === 'string' ? record.organizationUrlKey : undefined,
    displayName: record.displayName,
    email: typeof record.email === 'string' ? record.email : null
  }
}

function emptyWorkspaceFile(): LinearWorkspaceFile {
  return {
    version: 1,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspaces: []
  }
}

function readWorkspaceFileFromDisk(): LinearWorkspaceFile {
  const path = getWorkspaceFilePath()
  if (!existsSync(path)) {
    return emptyWorkspaceFile()
  }
  try {
    const raw = readFileSync(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as Partial<LinearWorkspaceFile>
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is LinearWorkspace => workspace !== null)
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

    return {
      version: 1,
      activeWorkspaceId,
      selectedWorkspaceId,
      workspaces
    }
  } catch {
    return emptyWorkspaceFile()
  }
}

function getWorkspaceFile(): LinearWorkspaceFile {
  if (!workspaceFileLoadedFromDisk || !cachedWorkspaceFile) {
    cachedWorkspaceFile = readWorkspaceFileFromDisk()
    workspaceFileLoadedFromDisk = true
  }
  return cachedWorkspaceFile
}

function writeWorkspaceFile(file: LinearWorkspaceFile): void {
  ensureOrcaDir()
  const persistedWorkspaces = file.workspaces.filter(
    (workspace) => workspace.id !== LEGACY_WORKSPACE_ID
  )
  const selectableIds = new Set(persistedWorkspaces.map((workspace) => workspace.id))
  if (hasStoredToken(LEGACY_WORKSPACE_ID)) {
    selectableIds.add(LEGACY_WORKSPACE_ID)
  }
  const activeWorkspaceId =
    file.activeWorkspaceId && selectableIds.has(file.activeWorkspaceId)
      ? file.activeWorkspaceId
      : (persistedWorkspaces[0]?.id ??
        (selectableIds.has(LEGACY_WORKSPACE_ID) ? LEGACY_WORKSPACE_ID : null))
  const selectedWorkspaceId =
    file.selectedWorkspaceId === 'all'
      ? 'all'
      : file.selectedWorkspaceId && selectableIds.has(file.selectedWorkspaceId)
        ? file.selectedWorkspaceId
        : activeWorkspaceId

  cachedWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces: persistedWorkspaces
  }
  workspaceFileLoadedFromDisk = true
  writeFileSync(getWorkspaceFilePath(), JSON.stringify(cachedWorkspaceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function getLegacyWorkspace(): LinearWorkspace | null {
  if (!hasStoredToken(LEGACY_WORKSPACE_ID)) {
    return null
  }
  const viewer = getLegacyViewer()
  return {
    id: LEGACY_WORKSPACE_ID,
    organizationId: viewer?.organizationId ?? LEGACY_WORKSPACE_ID,
    organizationName: viewer?.organizationName ?? 'Saved Linear workspace',
    organizationUrlKey: viewer?.organizationUrlKey,
    displayName: viewer?.displayName ?? 'Linear API key',
    email: viewer?.email ?? null,
    isLegacy: true
  }
}

function getWorkspaceState(): LinearWorkspaceFile {
  const file = getWorkspaceFile()
  const legacyWorkspace = getLegacyWorkspace()
  const workspaces = [
    ...(legacyWorkspace ? [legacyWorkspace] : []),
    ...file.workspaces.filter((workspace) => hasStoredToken(workspace.id))
  ]
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

  return {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  }
}

function clearLegacyViewerOnDisk(): void {
  try {
    unlinkSync(getLegacyViewerPath())
  } catch {
    // File may not exist — safe to ignore.
  }
}

function writeEncryptedToken(path: string, apiKey: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiKey)
    writeFileSync(path, encrypted, { mode: 0o600 })
    return
  }

  console.warn('[linear] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, apiKey, { encoding: 'utf-8', mode: 0o600 })
}

function saveWorkspaceToken(workspaceId: string, apiKey: string): void {
  ensureOrcaDir()
  if (workspaceId !== LEGACY_WORKSPACE_ID) {
    ensureWorkspaceTokenDir()
  }
  const tokenPath = getWorkspaceTokenPath(workspaceId)
  writeEncryptedToken(tokenPath, apiKey)
  cachedTokens.set(workspaceId, apiKey)
}

// Backward-compatible export for the legacy single-workspace storage path.
export function saveToken(apiKey: string): void {
  saveWorkspaceToken(LEGACY_WORKSPACE_ID, apiKey)
}

export function loadToken(options: { force?: boolean; workspaceId?: string } = {}): string | null {
  const workspaceId = options.workspaceId ?? resolveWorkspaceId()
  if (!workspaceId) {
    return null
  }
  const cached = cachedTokens.get(workspaceId)
  if (cached !== undefined) {
    return cached
  }
  if (!options.force) {
    return null
  }
  const tokenPath = getWorkspaceTokenPath(workspaceId)
  if (!existsSync(tokenPath)) {
    return null
  }
  try {
    const raw = readFileSync(tokenPath)
    const token = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8')
    cachedTokens.set(workspaceId, token)
    return token
  } catch {
    return null
  }
}

export function hasStoredToken(workspaceId?: string): boolean {
  if (!workspaceId) {
    return getWorkspaceState().workspaces.length > 0
  }
  if (cachedTokens.has(workspaceId)) {
    return true
  }
  return existsSync(getWorkspaceTokenPath(workspaceId))
}

function clearTokenFile(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  try {
    unlinkSync(getWorkspaceTokenPath(workspaceId))
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function clearToken(workspaceId?: string): void {
  if (!workspaceId) {
    const state = getWorkspaceState()
    for (const workspace of state.workspaces) {
      clearTokenFile(workspace.id)
    }
    cachedTokens = new Map()
    cachedLegacyViewer = null
    legacyViewerLoadedFromDisk = false
    cachedWorkspaceFile = emptyWorkspaceFile()
    workspaceFileLoadedFromDisk = true
    clearLegacyViewerOnDisk()
    writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  clearTokenFile(workspaceId)
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    cachedLegacyViewer = null
    legacyViewerLoadedFromDisk = false
    clearLegacyViewerOnDisk()
    return
  }

  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const activeWorkspaceId =
    file.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : file.activeWorkspaceId
  const selectedWorkspaceId =
    file.selectedWorkspaceId === workspaceId ? activeWorkspaceId : file.selectedWorkspaceId
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  })
}

function workspaceFromLinearData(
  me: { displayName: string; email?: string | null },
  org: { id: string; name: string; urlKey?: string | null }
): LinearWorkspace {
  return {
    id: org.id,
    organizationId: org.id,
    organizationName: org.name,
    organizationUrlKey: org.urlKey ?? undefined,
    displayName: me.displayName,
    email: me.email ?? null
  }
}

function upsertWorkspace(workspace: LinearWorkspace, options: { select?: boolean } = {}): void {
  const file = getWorkspaceFile()
  const withoutCurrent = file.workspaces.filter((entry) => entry.id !== workspace.id)
  const workspaces = [...withoutCurrent, workspace].sort((a, b) =>
    a.organizationName.localeCompare(b.organizationName)
  )
  const selectedWorkspaceId = options.select
    ? workspace.id
    : file.selectedWorkspaceId && file.selectedWorkspaceId !== LEGACY_WORKSPACE_ID
      ? file.selectedWorkspaceId
      : workspace.id
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspace.id,
    selectedWorkspaceId,
    workspaces
  })
}

function replaceLegacyWorkspace(workspace: LinearWorkspace, token: string): void {
  saveWorkspaceToken(workspace.id, token)
  clearTokenFile(LEGACY_WORKSPACE_ID)
  clearLegacyViewerOnDisk()
  cachedLegacyViewer = null
  legacyViewerLoadedFromDisk = true
  upsertWorkspace(workspace, { select: true })
}

function resolveWorkspaceId(workspaceId?: string | null): string | null {
  if (workspaceId && workspaceId !== 'all') {
    return workspaceId
  }
  const state = getWorkspaceState()
  if (
    state.selectedWorkspaceId &&
    state.selectedWorkspaceId !== 'all' &&
    state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)
  ) {
    return state.selectedWorkspaceId
  }
  if (
    state.activeWorkspaceId &&
    state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
  ) {
    return state.activeWorkspaceId
  }
  return state.workspaces[0]?.id ?? null
}

// ── Client factory ───────────────────────────────────────────────────
// Why: issues/teams modules call this for real Linear actions — at that point
// decrypting the token and surfacing a keychain prompt is expected.
export function getClient(workspaceId?: string | null): LinearClient | null {
  const token = loadToken({
    force: true,
    workspaceId: resolveWorkspaceId(workspaceId) ?? undefined
  })
  if (!token) {
    return null
  }
  return new LinearClient({ apiKey: token })
}

export function getClients(
  workspaceId?: LinearWorkspaceSelection | null
): LinearClientForWorkspace[] {
  const state = getWorkspaceState()
  const selectedWorkspaces =
    workspaceId === 'all'
      ? state.workspaces
      : state.workspaces.filter((workspace) => workspace.id === resolveWorkspaceId(workspaceId))

  const clients: LinearClientForWorkspace[] = []
  for (const workspace of selectedWorkspaces) {
    const token = loadToken({ force: true, workspaceId: workspace.id })
    if (!token) {
      continue
    }
    clients.push({ workspace, client: new LinearClient({ apiKey: token }) })
  }
  return clients
}

// ── Auth error detection ─────────────────────────────────────────────
// Why: 401 errors must trigger token clearing and a re-auth prompt in the
// renderer. All other errors are swallowed with console.warn to match GitHub
// client's graceful degradation.
export function isAuthError(error: unknown): boolean {
  return error instanceof AuthenticationLinearError
}

// ── Connect / disconnect / status ────────────────────────────────────
export async function connect(
  apiKey: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  try {
    const client = new LinearClient({ apiKey })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)

    saveWorkspaceToken(workspace.id, apiKey)
    const legacyWorkspace = getLegacyWorkspace()
    if (
      legacyWorkspace &&
      legacyWorkspace.organizationName === workspace.organizationName &&
      legacyWorkspace.email === workspace.email
    ) {
      clearTokenFile(LEGACY_WORKSPACE_ID)
      clearLegacyViewerOnDisk()
      cachedLegacyViewer = null
      legacyViewerLoadedFromDisk = true
    }
    upsertWorkspace(workspace, { select: true })
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate API key'
    return { ok: false, error: message }
  }
}

export function disconnect(workspaceId?: string): void {
  clearToken(workspaceId)
}

export function selectWorkspace(workspaceId: LinearWorkspaceSelection): LinearConnectionStatus {
  const state = getWorkspaceState()
  if (
    workspaceId !== 'all' &&
    !state.workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    return getStatus()
  }

  const file = getWorkspaceFile()
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId: workspaceId === 'all' ? file.activeWorkspaceId : workspaceId,
    selectedWorkspaceId: workspaceId,
    workspaces: file.workspaces
  })
  return getStatus()
}

export function getStatus(): LinearConnectionStatus {
  const state = getWorkspaceState()
  const selectedWorkspace =
    state.selectedWorkspaceId && state.selectedWorkspaceId !== 'all'
      ? state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
      : null
  const activeWorkspace =
    selectedWorkspace ??
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0] ??
    null

  return {
    connected: state.workspaces.length > 0,
    viewer: activeWorkspace,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    selectedWorkspaceId: state.selectedWorkspaceId
  }
}

export async function testConnection(
  workspaceId?: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  const resolvedWorkspaceId = resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return { ok: false, error: 'No API key stored.' }
  }
  const token = loadToken({ force: true, workspaceId: resolvedWorkspaceId })
  if (!token) {
    return { ok: false, error: 'No API key stored.' }
  }

  try {
    const client = new LinearClient({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)
    if (resolvedWorkspaceId === LEGACY_WORKSPACE_ID) {
      replaceLegacyWorkspace(workspace, token)
    } else {
      saveWorkspaceToken(workspace.id, token)
      upsertWorkspace(workspace, { select: true })
    }
    return { ok: true, viewer: workspace, workspace }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(resolvedWorkspaceId)
    }
    const message = error instanceof Error ? error.message : 'Test failed'
    return { ok: false, error: message }
  }
}

// Why: called at main-process startup. We warm plaintext metadata only; tokens
// stay encrypted on disk until a user performs an actual Linear action.
export function initLinearToken(): void {
  getWorkspaceFile()
  getLegacyViewer()
}
