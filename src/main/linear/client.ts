/* eslint-disable max-lines -- Why: Linear credential storage and client
   selection share one module so keychain-safe status reads and token mutation
   stay in one consistency boundary. */
import { safeStorage } from 'electron'
import type { LinearClient } from '@linear/sdk'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadLinearSdk } from './linear-sdk'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readIntegrationCredentialFileSync,
  readIntegrationCredentialFileSyncText,
  readStoredCredentialToken
} from '../integration-credential-file'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../shared/types'
import { IntegrationApiConcurrencyGate } from '../integration-api-concurrency'
import {
  assertIntegrationAccountCount,
  assertIntegrationCredentialBytes,
  assertIntegrationStringBytes,
  IntegrationAccountPersistenceLimitError,
  MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES,
  MAX_INTEGRATION_ACCOUNT_FILE_BYTES,
  MAX_INTEGRATION_ACCOUNT_ID_BYTES,
  MAX_INTEGRATION_ACCOUNT_LABEL_BYTES,
  MAX_INTEGRATION_ACCOUNTS,
  serializeIntegrationAccountFile,
  unreadableIntegrationAccountFileError
} from '../integration-account-persistence-limits'
import { boundedIntegrationErrorMessage } from '../integration-error-message'

// ── Concurrency limiter — max 4 parallel Linear API calls ────────────
const MAX_CONCURRENT = 4
const concurrencyGate = new IntegrationApiConcurrencyGate(MAX_CONCURRENT)

export function acquire(): Promise<void> {
  return concurrencyGate.acquire()
}

export function release(): void {
  concurrencyGate.release()
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
  apiKey: string
}

export const LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS = 60 * 60

let cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per workspace so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()
let cachedLegacyViewer: LinearViewer | null = null
let legacyViewerLoadedFromDisk = false
let cachedWorkspaceFile: LinearWorkspaceFile | null = null
let workspaceFileLoadedFromDisk = false
let workspaceFileReadError: Error | null = null

function cacheToken(workspaceId: string, token: string): void {
  if (!cachedTokens.has(workspaceId) && cachedTokens.size >= MAX_INTEGRATION_ACCOUNTS) {
    const oldestWorkspaceId = cachedTokens.keys().next().value
    if (oldestWorkspaceId !== undefined) {
      cachedTokens.delete(oldestWorkspaceId)
    }
  }
  cachedTokens.set(workspaceId, token)
}

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
  assertIntegrationStringBytes(
    'Linear',
    'workspace ID',
    workspaceId,
    MAX_INTEGRATION_ACCOUNT_ID_BYTES
  )
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
    const raw = readIntegrationCredentialFileSyncText(path)
    const parsed = JSON.parse(raw) as Partial<LinearViewer>
    if (typeof parsed?.displayName !== 'string' || typeof parsed?.organizationName !== 'string') {
      return null
    }
    assertIntegrationStringBytes(
      'Linear',
      'legacy display name',
      parsed.displayName,
      MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
    )
    assertIntegrationStringBytes(
      'Linear',
      'legacy organization name',
      parsed.organizationName,
      MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
    )
    if (typeof parsed.email === 'string') {
      assertIntegrationStringBytes(
        'Linear',
        'legacy email',
        parsed.email,
        MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES
      )
    }
    if (typeof parsed.organizationId === 'string') {
      assertIntegrationStringBytes(
        'Linear',
        'legacy organization ID',
        parsed.organizationId,
        MAX_INTEGRATION_ACCOUNT_ID_BYTES
      )
    }
    if (typeof parsed.organizationUrlKey === 'string') {
      assertIntegrationStringBytes(
        'Linear',
        'legacy organization URL key',
        parsed.organizationUrlKey,
        MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
      )
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
    email: typeof record.email === 'string' ? record.email : null,
    credentialRevision:
      typeof record.credentialRevision === 'number' && Number.isFinite(record.credentialRevision)
        ? record.credentialRevision
        : undefined
  }
}

function assertWorkspaceBounds(workspace: LinearWorkspace): void {
  assertIntegrationStringBytes(
    'Linear',
    'workspace ID',
    workspace.id,
    MAX_INTEGRATION_ACCOUNT_ID_BYTES
  )
  assertIntegrationStringBytes(
    'Linear',
    'organization ID',
    workspace.organizationId,
    MAX_INTEGRATION_ACCOUNT_ID_BYTES
  )
  assertIntegrationStringBytes(
    'Linear',
    'organization name',
    workspace.organizationName,
    MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
  )
  if (workspace.organizationUrlKey !== undefined) {
    assertIntegrationStringBytes(
      'Linear',
      'organization URL key',
      workspace.organizationUrlKey,
      MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
    )
  }
  assertIntegrationStringBytes(
    'Linear',
    'display name',
    workspace.displayName,
    MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
  )
  if (workspace.email !== null) {
    assertIntegrationStringBytes(
      'Linear',
      'email',
      workspace.email,
      MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES
    )
  }
}

function assertStoredWorkspaceBounds(input: unknown): void {
  if (!input || typeof input !== 'object') {
    return
  }
  const record = input as Record<string, unknown>
  const fields = [
    ['workspace ID', record.id, MAX_INTEGRATION_ACCOUNT_ID_BYTES],
    ['organization ID', record.organizationId, MAX_INTEGRATION_ACCOUNT_ID_BYTES],
    ['organization name', record.organizationName, MAX_INTEGRATION_ACCOUNT_LABEL_BYTES],
    ['organization URL key', record.organizationUrlKey, MAX_INTEGRATION_ACCOUNT_LABEL_BYTES],
    ['display name', record.displayName, MAX_INTEGRATION_ACCOUNT_LABEL_BYTES],
    ['email', record.email, MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES]
  ] as const
  for (const [field, value, maxBytes] of fields) {
    if (typeof value === 'string') {
      assertIntegrationStringBytes('Linear', field, value, maxBytes)
    }
  }
}

function assertWorkspaceFileBounds(file: LinearWorkspaceFile): void {
  assertIntegrationAccountCount('Linear', file.workspaces.length)
  for (const workspace of file.workspaces) {
    assertWorkspaceBounds(workspace)
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
    workspaceFileReadError = null
    return emptyWorkspaceFile()
  }
  try {
    const raw = readIntegrationCredentialFileSyncText(path)
    const parsed = JSON.parse(raw) as Partial<LinearWorkspaceFile>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.workspaces)
    ) {
      throw unreadableIntegrationAccountFileError('Linear')
    }
    if (typeof parsed.activeWorkspaceId === 'string') {
      assertIntegrationStringBytes(
        'Linear',
        'active workspace ID',
        parsed.activeWorkspaceId,
        MAX_INTEGRATION_ACCOUNT_ID_BYTES
      )
    }
    if (typeof parsed.selectedWorkspaceId === 'string' && parsed.selectedWorkspaceId !== 'all') {
      assertIntegrationStringBytes(
        'Linear',
        'selected workspace ID',
        parsed.selectedWorkspaceId,
        MAX_INTEGRATION_ACCOUNT_ID_BYTES
      )
    }
    const workspaces: LinearWorkspace[] = []
    assertIntegrationAccountCount('Linear', parsed.workspaces.length)
    for (const input of parsed.workspaces) {
      assertStoredWorkspaceBounds(input)
      const workspace = normalizeWorkspace(input)
      if (!workspace) {
        throw unreadableIntegrationAccountFileError('Linear')
      }
      if (hasStoredToken(workspace.id)) {
        workspaces.push(workspace)
      }
    }
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

    workspaceFileReadError = null
    return {
      version: 1,
      activeWorkspaceId,
      selectedWorkspaceId,
      workspaces
    }
  } catch {
    workspaceFileReadError = unreadableIntegrationAccountFileError('Linear')
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
  if (workspaceFileReadError) {
    throw workspaceFileReadError
  }
  assertWorkspaceFileBounds(file)
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

  const nextFile: LinearWorkspaceFile = {
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces: persistedWorkspaces
  }
  const serialized = serializeIntegrationAccountFile(nextFile)
  writeFileSync(getWorkspaceFilePath(), serialized, {
    encoding: 'utf-8',
    mode: 0o600
  })
  cachedWorkspaceFile = nextFile
  workspaceFileLoadedFromDisk = true
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
  assertIntegrationCredentialBytes('Linear', apiKey)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiKey)
    if (encrypted.length > MAX_INTEGRATION_ACCOUNT_FILE_BYTES) {
      throw new IntegrationAccountPersistenceLimitError(
        `Linear encrypted credential exceeds ${MAX_INTEGRATION_ACCOUNT_FILE_BYTES} bytes.`
      )
    }
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
  cacheToken(workspaceId, apiKey)
  credentialErrors.delete(workspaceId)
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
  if (
    workspaceId !== LEGACY_WORKSPACE_ID &&
    !getWorkspaceState().workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
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
    const raw = readIntegrationCredentialFileSync(tokenPath)
    const token = readStoredCredentialToken('Linear', raw)
    if (token) {
      assertIntegrationCredentialBytes('Linear', token)
      cacheToken(workspaceId, token)
    }
    credentialErrors.delete(workspaceId)
    return token
  } catch (error) {
    if (
      error instanceof CredentialDecryptionError ||
      error instanceof IntegrationAccountPersistenceLimitError
    ) {
      credentialErrors.set(workspaceId, error.message)
      throw error
    }
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
  return credentialFileHasContent(getWorkspaceTokenPath(workspaceId))
}

function clearTokenFile(workspaceId: string): void {
  cachedTokens.delete(workspaceId)
  credentialErrors.delete(workspaceId)
  try {
    unlinkSync(getWorkspaceTokenPath(workspaceId))
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function clearToken(workspaceId?: string): void {
  getWorkspaceFile()
  if (workspaceFileReadError) {
    throw workspaceFileReadError
  }
  if (!workspaceId) {
    const state = getWorkspaceState()
    for (const workspace of state.workspaces) {
      clearTokenFile(workspace.id)
    }
    cachedTokens = new Map()
    credentialErrors.clear()
    cachedLegacyViewer = null
    legacyViewerLoadedFromDisk = false
    cachedWorkspaceFile = emptyWorkspaceFile()
    workspaceFileLoadedFromDisk = true
    clearLegacyViewerOnDisk()
    writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  if (!getWorkspaceState().workspaces.some((workspace) => workspace.id === workspaceId)) {
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

function workspaceFileWithUpsert(
  workspace: LinearWorkspace,
  options: { select?: boolean } = {}
): LinearWorkspaceFile {
  const file = getWorkspaceFile()
  const current = file.workspaces.find((entry) => entry.id === workspace.id)
  const credentialRevision = (current?.credentialRevision ?? 0) + 1
  const workspaceWithRevision = { ...workspace, credentialRevision }
  const withoutCurrent = file.workspaces.filter((entry) => entry.id !== workspace.id)
  const workspaces = [...withoutCurrent, workspaceWithRevision].sort((a, b) =>
    a.organizationName.localeCompare(b.organizationName)
  )
  const selectedWorkspaceId = options.select
    ? workspace.id
    : file.selectedWorkspaceId && file.selectedWorkspaceId !== LEGACY_WORKSPACE_ID
      ? file.selectedWorkspaceId
      : workspace.id
  return {
    version: 1,
    activeWorkspaceId: workspace.id,
    selectedWorkspaceId,
    workspaces
  }
}

function upsertWorkspace(workspace: LinearWorkspace, options: { select?: boolean } = {}): void {
  writeWorkspaceFile(workspaceFileWithUpsert(workspace, options))
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
    const state = getWorkspaceState()
    return state.workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : null
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
  return new (loadLinearSdk().LinearClient)({ apiKey: token })
}

export function getClients(
  workspaceId?: LinearWorkspaceSelection | null
): LinearClientForWorkspace[] {
  const state = getWorkspaceState()
  const isAllSelection = workspaceId === 'all'
  const selectedWorkspaces = isAllSelection
    ? state.workspaces
    : state.workspaces.filter((workspace) => workspace.id === resolveWorkspaceId(workspaceId))

  const clients: LinearClientForWorkspace[] = []
  for (const workspace of selectedWorkspaces) {
    let token: string | null
    try {
      token = loadToken({ force: true, workspaceId: workspace.id })
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable workspace must not
      // collapse reads for the healthy ones. loadToken already recorded the
      // per-workspace credentialError for getStatus to surface, so skip this
      // workspace like a missing token. A specific-workspace selection still
      // rethrows so the renderer can surface the decrypt banner promptly.
      if (
        isAllSelection &&
        (error instanceof CredentialDecryptionError ||
          error instanceof IntegrationAccountPersistenceLimitError)
      ) {
        continue
      }
      throw error
    }
    if (!token) {
      continue
    }
    clients.push({
      workspace,
      client: new (loadLinearSdk().LinearClient)({ apiKey: token }),
      apiKey: token
    })
  }
  return clients
}

export function getPublicFileUrlClient(entry: LinearClientForWorkspace): LinearClient {
  return new (loadLinearSdk().LinearClient)({
    apiKey: entry.apiKey,
    headers: {
      'public-file-urls-expire-in': String(LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
    }
  })
}

// ── Auth error detection ─────────────────────────────────────────────
// Why: 401 errors must trigger token clearing and a re-auth prompt in the
// renderer. All other errors are swallowed with console.warn to match GitHub
// client's graceful degradation.
export function isAuthError(error: unknown): boolean {
  return error instanceof loadLinearSdk().AuthenticationLinearError
}

// ── Connect / disconnect / status ────────────────────────────────────
export async function connect(
  apiKey: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  try {
    assertIntegrationCredentialBytes('Linear', apiKey)
    getWorkspaceFile()
    if (workspaceFileReadError) {
      throw workspaceFileReadError
    }
    const client = new (loadLinearSdk().LinearClient)({ apiKey })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)

    assertWorkspaceBounds(workspace)
    const legacyWorkspace = getLegacyWorkspace()
    const candidateFile = workspaceFileWithUpsert(workspace, { select: true })
    assertWorkspaceFileBounds(candidateFile)
    serializeIntegrationAccountFile(candidateFile)
    saveWorkspaceToken(workspace.id, apiKey)
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
    const message =
      error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Failed to validate API key'
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

  const credentialError = state.workspaces
    .map((workspace) => credentialErrors.get(workspace.id))
    .find((message) => message !== undefined)

  return {
    connected: state.workspaces.length > 0,
    viewer: activeWorkspace,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function testConnection(
  workspaceId?: string
): Promise<
  { ok: true; viewer: LinearViewer; workspace: LinearWorkspace } | { ok: false; error: string }
> {
  getWorkspaceFile()
  if (workspaceFileReadError) {
    return { ok: false, error: workspaceFileReadError.message }
  }
  const resolvedWorkspaceId = resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return { ok: false, error: 'No API key stored.' }
  }
  let token: string | null
  try {
    token = loadToken({ force: true, workspaceId: resolvedWorkspaceId })
  } catch (error) {
    const message = error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Test failed'
    return { ok: false, error: message }
  }
  if (!token) {
    return { ok: false, error: 'No API key stored.' }
  }

  try {
    const client = new (loadLinearSdk().LinearClient)({ apiKey: token })
    const me = await client.viewer
    const org = await me.organization
    const workspace = workspaceFromLinearData(me, org)
    assertWorkspaceBounds(workspace)
    const candidateFile = workspaceFileWithUpsert(workspace, { select: true })
    assertWorkspaceFileBounds(candidateFile)
    serializeIntegrationAccountFile(candidateFile)
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
    const message = error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Test failed'
    return { ok: false, error: message }
  }
}

// Why: called at main-process startup. We warm plaintext metadata only; tokens
// stay encrypted on disk until a user performs an actual Linear action.
export function initLinearToken(): void {
  getWorkspaceFile()
  getLegacyViewer()
}
