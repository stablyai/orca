import type {
  CloudWorkspace,
  CloudWorkspaceGrant,
  CloudWorkspaceListQuery,
  CloudWorkspacePatch,
  OrgPrompts
} from '../../shared/cloud-workspaces/cloud-workspaces-wire'

export type CloudWorkspacesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; reason?: string; status?: number }

export type LocalCloudWorkspace = {
  sandboxId: string
  worktreeId: string | null
  runtimeEnvironmentId: string | null
}

/** The runtime environment a granted workspace was added as, and the grant that paired it. */
export type CloudWorkspaceBinding = { environmentId: string; grantId: string | null }

export type CloudWorkspacesApi = {
  /** False when this build has no Orca Cloud control plane configured. */
  available: () => Promise<boolean>
  list: (query: CloudWorkspaceListQuery) => Promise<CloudWorkspacesResult<CloudWorkspace[]>>
  get: (id: string) => Promise<CloudWorkspacesResult<CloudWorkspace>>
  patch: (id: string, patch: CloudWorkspacePatch) => Promise<CloudWorkspacesResult<CloudWorkspace>>
  resolveLink: (
    workspaceId: string,
    chatId?: string | null
  ) => Promise<CloudWorkspacesResult<{ workspace: CloudWorkspace; chatId: string | null }>>
  /** A fresh per-device pairing link for a teammate's workspace (E2EE grant, opened in main). */
  openGrant: (
    id: string
  ) => Promise<CloudWorkspacesResult<{ grantId: string; pairingCode: string }>>
  listGrants: (id: string) => Promise<CloudWorkspacesResult<CloudWorkspaceGrant[]>>
  revokeGrant: (id: string, grantId: string) => Promise<CloudWorkspacesResult<void>>
  localWorkspaces: () => Promise<LocalCloudWorkspace[]>
  /** Remembers which local runtime environment a granted workspace was added as. */
  bindEnvironment: (
    sandboxId: string,
    runtimeEnvironmentId: string,
    grantId?: string | null
  ) => Promise<void>
  environmentBindings: () => Promise<Record<string, CloudWorkspaceBinding>>
  setActive: (args: {
    sandboxId: string | null
    chatId?: string | null
    typing?: boolean
    leased?: boolean
  }) => Promise<void>
  getOrgPrompts: () => Promise<CloudWorkspacesResult<OrgPrompts>>
  putOrgPrompts: (
    document: OrgPrompts['document'],
    revision: number
  ) => Promise<CloudWorkspacesResult<OrgPrompts>>
  onOpenLink: (callback: (link: string) => void) => () => void
  consumePendingLink: () => Promise<string | null>
}
