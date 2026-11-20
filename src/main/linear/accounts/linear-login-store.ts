import { inCredentialFileOrder } from '../../credentials/credential-file-io'
// The person's own Linear login that Connect Linear hands this Mac (read,write, refreshed here with
// the app's client id alone). An API key saved for the same workspace always comes first.
import { readFile, unlink } from 'node:fs/promises'
import {
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../../credentials/integration-credential-file'
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
  inWorkspaceRegistryOrder,
  workspaceLoginFileCache
} from './linear-workspace-registry'
import type { ConnectorConnectRedeem } from '../../../../cloud/packages/connector-contract/src/connect-messages'

export type LinearLogin = ConnectLogin

async function refreshTokenOnDisk(workspaceId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(getWorkspaceLoginPath(workspaceId))
    const token = readStoredCredentialToken('Linear', raw)
    return token ? ConnectLoginSchema.parse(JSON.parse(token)).refreshToken : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export async function saveWorkspaceLogin(
  workspaceId: string,
  login: LinearLogin,
  expectedRefreshToken?: string
): Promise<void> {
  return inCredentialFileOrder(`${getWorkspaceLoginPath(workspaceId)}.mutation`, async () => {
    if (
      expectedRefreshToken !== undefined &&
      (await refreshTokenOnDisk(workspaceId)) !== expectedRefreshToken
    ) {
      return
    }
    await ensureOrcaDir()
    await ensureWorkspaceTokenDir()
    await writeEncryptedCredential(
      'Linear',
      getWorkspaceLoginPath(workspaceId),
      JSON.stringify(login)
    )
    workspaceLoginFileCache.forget(workspaceId)
  })
}

/** The saved login, or null when there is none or it can't be read. */
export async function readWorkspaceLogin(workspaceId: string): Promise<LinearLogin | null> {
  const raw = await workspaceLoginFileCache.read(workspaceId)
  if (raw === null) {
    return null
  }
  try {
    return ConnectLoginSchema.safeParse(JSON.parse(raw)).data ?? null
  } catch {
    return null
  }
}

export async function hasWorkspaceLogin(workspaceId: string): Promise<boolean> {
  return workspaceLoginFileCache.has(workspaceId)
}

export async function clearWorkspaceLogin(
  workspaceId: string,
  expectedRefreshToken?: string
): Promise<void> {
  return inCredentialFileOrder(`${getWorkspaceLoginPath(workspaceId)}.mutation`, async () => {
    if (
      expectedRefreshToken !== undefined &&
      (await refreshTokenOnDisk(workspaceId)) !== expectedRefreshToken
    ) {
      return
    }
    workspaceLoginFileCache.forget(workspaceId)
    try {
      await unlink(getWorkspaceLoginPath(workspaceId))
    } catch {
      // Nothing saved.
    }
  })
}

/** Keeps the login Connect Linear handed over, for the workspace the person signed in to. */
export async function keepConnectedLinearLogin(
  login: LinearLogin,
  linked: Pick<ConnectorConnectRedeem, 'identity' | 'workspace'>
): Promise<void> {
  const { workspace, identity } = linked
  if (!workspace) {
    return
  }
  await inWorkspaceRegistryOrder(async (upsert) => {
    await saveWorkspaceLogin(workspace.id, login)
    if ((await getWorkspaceFile()).workspaces.some((entry) => entry.id === workspace.id)) {
      return
    }
    await upsert(
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
  })
}
