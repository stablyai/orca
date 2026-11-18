import { unlinkSync } from 'node:fs'
import { writeEncryptedCredential } from '../../credentials/integration-credential-file'
import {
  LEGACY_WORKSPACE_ID,
  ensureOrcaDir,
  ensureWorkspaceTokenDir,
  getWorkspaceTokenPath
} from './linear-credential-paths'
import {
  clearLegacyViewerOnDisk,
  forgetLegacyViewer,
  resetLegacyViewerCache
} from './linear-legacy-viewer-store'
import { emptyWorkspaceFile } from './linear-workspace-record'
import {
  getWorkspaceFile,
  getWorkspaceState,
  resetCredentialCaches,
  resetWorkspaceFileCacheToEmpty,
  resolveWorkspaceId,
  upsertWorkspace,
  writeWorkspaceFile,
  workspaceTokenFileCache
} from './linear-workspace-registry'
import type { LinearWorkspace } from '../../../shared/linear/workspace-types'
import { readCredentialFileProtection } from '../../credentials/credential-file-protection'
import { clearWorkspaceLogin, readWorkspaceLogin } from './linear-login-store'
import { refreshLinearLogin, refreshLinearLoginIfDue } from './linear-login-refresh'
import type { SecretAtRestProtection } from '../../../shared/secure-storage/secret-at-rest-protection'

export function saveWorkspaceToken(workspaceId: string, apiKey: string): void {
  ensureOrcaDir()
  if (workspaceId !== LEGACY_WORKSPACE_ID) {
    ensureWorkspaceTokenDir()
  }
  const tokenPath = getWorkspaceTokenPath(workspaceId)
  // Credential writes restore existing file permissions and publish without truncating live contents.
  writeEncryptedCredential('Linear', tokenPath, apiKey)
  workspaceTokenFileCache.forget(workspaceId)
}

export function loadToken(options: { force?: boolean; workspaceId?: string } = {}): string | null {
  const workspaceId = options.workspaceId ?? resolveWorkspaceId()
  if (!workspaceId) {
    return null
  }
  return workspaceTokenFileCache.read(workspaceId, options.force === true)
}

// How Orca calls Linear for a workspace: its API key, else the login Connect Linear saved.
// A login also carries how to swap in a fresh token when Linear refuses the one it holds.
export type LinearCredential =
  | { apiKey: string }
  | { accessToken: string; reauthorize: () => Promise<string | null> }

export function loadCredential(workspaceId: string): LinearCredential | null {
  const apiKey = loadToken({ force: true, workspaceId })
  if (apiKey) {
    return { apiKey }
  }
  const login = readWorkspaceLogin(workspaceId)
  if (!login) {
    return null
  }
  refreshLinearLoginIfDue(workspaceId, login)
  let current = login.accessToken
  const reauthorize = async (): Promise<string | null> => {
    // Another call may already have refreshed it; refresh only a token that is still the refused one.
    if (readWorkspaceLogin(workspaceId)?.accessToken === current) {
      await refreshLinearLogin(workspaceId, undefined, true)
    }
    const next = readWorkspaceLogin(workspaceId)?.accessToken
    if (!next || next === current) {
      return null
    }
    current = next
    return `Bearer ${next}`
  }
  return { accessToken: login.accessToken, reauthorize }
}

export function getWorkspaceTokenProtection(workspaceId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getWorkspaceTokenPath(workspaceId))
}

export function clearTokenFile(workspaceId: string): void {
  clearWorkspaceLogin(workspaceId)
  workspaceTokenFileCache.forget(workspaceId)
  try {
    unlinkSync(getWorkspaceTokenPath(workspaceId))
  } catch {
    // Token cleanup is best-effort when storage is absent or unavailable.
  }
}

export function clearToken(workspaceId?: string): void {
  if (!workspaceId) {
    const state = getWorkspaceState()
    for (const workspace of state.workspaces) {
      clearTokenFile(workspace.id)
    }
    resetCredentialCaches()
    resetLegacyViewerCache()
    resetWorkspaceFileCacheToEmpty()
    clearLegacyViewerOnDisk()
    writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  clearTokenFile(workspaceId)
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    resetLegacyViewerCache()
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

export function replaceLegacyWorkspace(workspace: LinearWorkspace, token: string): void {
  saveWorkspaceToken(workspace.id, token)
  clearTokenFile(LEGACY_WORKSPACE_ID)
  clearLegacyViewerOnDisk()
  forgetLegacyViewer()
  upsertWorkspace(workspace, { select: true })
}
