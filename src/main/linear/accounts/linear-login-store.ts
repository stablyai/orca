// The person's own Linear login that Connect Linear hands this Mac (read,write, refreshed here with
// the app's client id alone). An API key saved for the same workspace always comes first.
import { unlinkSync } from 'node:fs'
import { writeEncryptedCredential } from '../../credentials/integration-credential-file'
import {
  ConnectLoginSchema,
  type ConnectLogin
} from '../../../../cloud/packages/connector-contract/src/connect-login-seal'
import {
  ensureOrcaDir,
  ensureWorkspaceTokenDir,
  getWorkspaceLoginPath
} from './linear-credential-paths'
import {
  getWorkspaceFile,
  upsertWorkspace,
  workspaceLoginFileCache
} from './linear-workspace-registry'
import type { ConnectorConnectRedeem } from '../../../../cloud/packages/connector-contract/src/connect-messages'

export type LinearLogin = ConnectLogin

export function saveWorkspaceLogin(workspaceId: string, login: LinearLogin): void {
  ensureOrcaDir()
  ensureWorkspaceTokenDir()
  writeEncryptedCredential('Linear', getWorkspaceLoginPath(workspaceId), JSON.stringify(login))
  workspaceLoginFileCache.forget(workspaceId)
}

/** The saved login, or null when there is none or it can't be read. */
export function readWorkspaceLogin(workspaceId: string): LinearLogin | null {
  const raw = workspaceLoginFileCache.read(workspaceId)
  if (raw === null) {
    return null
  }
  try {
    return ConnectLoginSchema.safeParse(JSON.parse(raw)).data ?? null
  } catch {
    return null
  }
}

export function hasWorkspaceLogin(workspaceId: string): boolean {
  return workspaceLoginFileCache.has(workspaceId)
}

export function clearWorkspaceLogin(workspaceId: string): void {
  workspaceLoginFileCache.forget(workspaceId)
  try {
    unlinkSync(getWorkspaceLoginPath(workspaceId))
  } catch {
    // Nothing saved.
  }
}

/** Keeps the login Connect Linear handed over, for the workspace the person signed in to. */
export function keepConnectedLinearLogin(
  login: LinearLogin,
  linked: Pick<ConnectorConnectRedeem, 'identity' | 'workspace'>
): void {
  const { workspace, identity } = linked
  if (!workspace) {
    return
  }
  saveWorkspaceLogin(workspace.id, login)
  if (getWorkspaceFile().workspaces.some((entry) => entry.id === workspace.id)) {
    return
  }
  upsertWorkspace(
    {
      id: workspace.id,
      organizationId: workspace.id,
      organizationName: workspace.name,
      ...(workspace.urlKey ? { organizationUrlKey: workspace.urlKey } : {}),
      displayName: identity.handle,
      email: identity.email ?? null
    },
    { keepActive: true }
  )
}
