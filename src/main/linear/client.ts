import type { LinearClient } from '@linear/sdk'
import { loadLinearSdk } from './linear-sdk'
import { LEGACY_WORKSPACE_ID } from './linear-credential-paths'
import {
  clearLegacyViewerOnDisk,
  forgetLegacyViewer,
  getLegacyViewer
} from './linear-legacy-viewer-store'
import { workspaceFromLinearData } from './linear-workspace-record'
import {
  getCredentialError,
  getLegacyWorkspace,
  getWorkspaceFile,
  getWorkspaceState,
  resolveWorkspaceId,
  upsertWorkspace,
  writeWorkspaceFile
} from './linear-workspace-registry'
import {
  clearToken,
  clearTokenFile,
  loadToken,
  replaceLegacyWorkspace,
  saveWorkspaceToken
} from './linear-token-store'
import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'

export type LinearClientForWorkspace = {
  workspace: LinearWorkspace
  client: LinearClient
  apiKey: string
}

export const LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS = 60 * 60

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
      if (isAllSelection && error instanceof CredentialDecryptionError) {
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
    const client = new (loadLinearSdk().LinearClient)({ apiKey })
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
      forgetLegacyViewer()
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

  const credentialError = state.workspaces
    .map((workspace) => getCredentialError(workspace.id))
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
  const resolvedWorkspaceId = resolveWorkspaceId(workspaceId)
  if (!resolvedWorkspaceId) {
    return { ok: false, error: 'No API key stored.' }
  }
  let token: string | null
  try {
    token = loadToken({ force: true, workspaceId: resolvedWorkspaceId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test failed'
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
