import type {
  CloudWorkspace,
  CloudWorkspaceFollow,
  CloudWorkspaceGrant,
  CloudOrgSlug,
  CloudWorkspaceLinkTarget,
  CloudWorkspaceListQuery,
  CloudWorkspacePatch,
  CloudWorkspacePrefs,
  CloudWorkspacePrefsDocument,
  CloudWorkspaceRoutineRuns,
  OrgPrompts
} from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { PokeInbox, TeammateProfile } from '../../shared/cloud-workspaces/team-presence-wire'
import type { CloudReadSnapshotState } from '../../shared/cloud-workspaces/read-snapshot-state'

export type CloudWorkspacesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; reason?: string; status?: number; orgId?: string }

/** A list read, plus what Home's Routine runs switch hides (absent from older control planes). */
export type CloudWorkspaceListResult =
  | { ok: true; value: CloudWorkspace[]; routineRuns?: CloudWorkspaceRoutineRuns }
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
  list: (query: CloudWorkspaceListQuery) => Promise<CloudWorkspaceListResult>
  get: (id: string) => Promise<CloudWorkspacesResult<CloudWorkspace>>
  patch: (id: string, patch: CloudWorkspacePatch) => Promise<CloudWorkspacesResult<CloudWorkspace>>
  /** Follow or unfollow a team workspace (PARITY-FOLLOW): the caller's state and its followers. */
  follow: (id: string, follow: boolean) => Promise<CloudWorkspacesResult<CloudWorkspaceFollow>>
  /** Resolves either link form; a slug link for another org fails with reason `other_org` and its `orgId`. */
  resolveLink: (
    target: CloudWorkspaceLinkTarget,
    chatId?: string | null
  ) => Promise<CloudWorkspacesResult<{ workspace: CloudWorkspace; chatId: string | null }>>
  /** A fresh per-device pairing link for a teammate's workspace (E2EE grant, opened in main). */
  openGrant: (
    id: string
  ) => Promise<CloudWorkspacesResult<{ grantId: string; pairingCode: string }>>
  /** A sleeping workspace's sealed read snapshot, opened in main with this device's reader key. Never wakes it. */
  readSnapshot: (id: string) => Promise<CloudWorkspacesResult<CloudReadSnapshotState>>
  listGrants: (id: string) => Promise<CloudWorkspacesResult<CloudWorkspaceGrant[]>>
  revokeGrant: (id: string, grantId: string) => Promise<CloudWorkspacesResult<void>>
  localWorkspaces: () => Promise<LocalCloudWorkspace[]>
  /** Owner or team admin, from the team list: sleep or delete a workspace this desktop doesn't run. */
  sleep: (id: string) => Promise<CloudWorkspacesResult<void>>
  /** A paired workspace's wake (this desktop has no VM record to resume); billing refusals come back as errors. */
  wake: (id: string) => Promise<CloudWorkspacesResult<void>>
  destroy: (id: string) => Promise<CloudWorkspacesResult<void>>
  /** "I just sent a message here" (opens my git-as-sender window on the control plane). */
  noteSent: (id: string) => Promise<void>
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
  /** This member's synced sidebar arrangement of cloud workspaces (pins, order, sections). */
  getPrefs: () => Promise<CloudWorkspacesResult<CloudWorkspacePrefs>>
  /** Compare-and-set on `revision`; a stale write fails with `conflict`. */
  putPrefs: (
    document: CloudWorkspacePrefsDocument,
    revision: number
  ) => Promise<CloudWorkspacesResult<CloudWorkspacePrefs>>
  /** The org's link slug; `orgName` names it the first time anyone asks. */
  getOrgSlug: (orgName?: string | null) => Promise<CloudWorkspacesResult<CloudOrgSlug>>
  /** A teammate's profile: usage heatmap (levels only unless it is you) and workspaces you can see. */
  teammateProfile: (
    userId: string,
    utcOffsetMin: number
  ) => Promise<CloudWorkspacesResult<TeammateProfile>>
  /** Pokes (experimental, opt-in on both sides). */
  poke: (userId: string) => Promise<CloudWorkspacesResult<{ id: string; at: number }>>
  pokeInbox: () => Promise<CloudWorkspacesResult<PokeInbox>>
  setPokesEnabled: (enabled: boolean) => Promise<CloudWorkspacesResult<boolean>>
  markPokesSeen: (ids: string[]) => Promise<CloudWorkspacesResult<void>>
  onOpenLink: (callback: (link: string) => void) => () => void
  consumePendingLink: () => Promise<string | null>
}
