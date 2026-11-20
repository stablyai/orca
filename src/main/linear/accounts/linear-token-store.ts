import { inCredentialFileOrder } from '../../credentials/credential-file-io'
import { unlink } from 'node:fs/promises'
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
  inWorkspaceRegistryOrder,
  getWorkspaceState,
  resetCredentialCaches,
  resetWorkspaceFileCacheToEmpty,
  resolveWorkspaceId,
  writeWorkspaceFile,
  workspaceTokenFileCache
} from './linear-workspace-registry'
import type { LinearWorkspace } from '../../../shared/linear/workspace-types'
import { readCredentialFileProtection } from '../../credentials/credential-file-protection'
import { clearWorkspaceLogin, readWorkspaceLogin } from './linear-login-store'
import { refreshLinearLogin, refreshLinearLoginIfDue } from './linear-login-refresh'
import type { SecretAtRestProtection } from '../../../shared/secure-storage/secret-at-rest-protection'

export async function saveWorkspaceToken(workspaceId: string, apiKey: string): Promise<void> {
  return inCredentialFileOrder(`${getWorkspaceTokenPath(workspaceId)}.mutation`, async () => {
    await ensureOrcaDir()
    if (workspaceId !== LEGACY_WORKSPACE_ID) {
      await ensureWorkspaceTokenDir()
    }
    const tokenPath = getWorkspaceTokenPath(workspaceId)
    // Credential writes restore existing file permissions and publish without truncating live contents.
    await writeEncryptedCredential('Linear', tokenPath, apiKey)
    workspaceTokenFileCache.forget(workspaceId)
  })
}

export async function loadToken(
  options: { force?: boolean; workspaceId?: string } = {}
): Promise<string | null> {
  const workspaceId = options.workspaceId ?? (await resolveWorkspaceId())
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

export async function loadCredential(workspaceId: string): Promise<LinearCredential | null> {
  const apiKey = await loadToken({ force: true, workspaceId })
  if (apiKey) {
    return { apiKey }
  }
  const login = await readWorkspaceLogin(workspaceId)
  if (!login) {
    return null
  }
  refreshLinearLoginIfDue(workspaceId, login)
  let current = login.accessToken
  const reauthorize = async (): Promise<string | null> => {
    // Another call may already have refreshed it; refresh only a token that is still the refused one.
    if ((await readWorkspaceLogin(workspaceId))?.accessToken === current) {
      await refreshLinearLogin(workspaceId, undefined, true)
    }
    const next = (await readWorkspaceLogin(workspaceId))?.accessToken
    if (!next || next === current) {
      return null
    }
    current = next
    return `Bearer ${next}`
  }
  return { accessToken: login.accessToken, reauthorize }
}

export async function getWorkspaceTokenProtection(
  workspaceId: string
): Promise<SecretAtRestProtection | null> {
  return readCredentialFileProtection(getWorkspaceTokenPath(workspaceId))
}

export async function clearTokenFile(workspaceId: string): Promise<void> {
  return inCredentialFileOrder(`${getWorkspaceTokenPath(workspaceId)}.mutation`, async () => {
    await clearWorkspaceLogin(workspaceId)
    workspaceTokenFileCache.forget(workspaceId)
    try {
      await unlink(getWorkspaceTokenPath(workspaceId))
    } catch {
      // Token cleanup is best-effort when storage is absent or unavailable.
    }
  })
}

export async function clearToken(workspaceId?: string): Promise<void> {
  return inWorkspaceRegistryOrder(() => clearStoredToken(workspaceId))
}

async function clearStoredToken(workspaceId?: string): Promise<void> {
  if (!workspaceId) {
    const state = await getWorkspaceState()
    for (const workspace of state.workspaces) {
      await clearTokenFile(workspace.id)
    }
    resetCredentialCaches()
    resetLegacyViewerCache()
    resetWorkspaceFileCacheToEmpty()
    clearLegacyViewerOnDisk()
    await writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  await clearTokenFile(workspaceId)
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    resetLegacyViewerCache()
    clearLegacyViewerOnDisk()
    return
  }

  const file = await getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const activeWorkspaceId =
    file.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : file.activeWorkspaceId
  const selectedWorkspaceId =
    file.selectedWorkspaceId === workspaceId ? activeWorkspaceId : file.selectedWorkspaceId
  await writeWorkspaceFile({
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  })
}

export async function replaceLegacyWorkspace(
  workspace: LinearWorkspace,
  token: string
): Promise<void> {
  await inWorkspaceRegistryOrder(async (upsert) => {
    await saveWorkspaceToken(workspace.id, token)
    await clearTokenFile(LEGACY_WORKSPACE_ID)
    clearLegacyViewerOnDisk()
    forgetLegacyViewer()
    await upsert(workspace, { select: true })
  })
}
