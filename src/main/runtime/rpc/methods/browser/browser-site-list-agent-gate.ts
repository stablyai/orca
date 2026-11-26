// An agent must not leave a browser profile that has a site list; the owner's Orca and phone may.
// Orca cannot prove which worktree an agent is in (the CLI sends it from its env), so each gate
// applies to the worktree the call names.
import type { RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../callers/rpc-caller-identity'
import {
  assertAgentMayLeaveProfile,
  assertAgentMayMoveBrowsingOut,
  browserProfileHasSiteList
} from '../../../../browser/sessions/site-list/browser-profile-site-list-lock'
import {
  getManagedBrowserProfileOwner,
  isManagedBrowserProfileOf
} from '../../../../../shared/browser/profiles/browser-profile-scope'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { Repo } from '../../../../../shared/repository/repo-types'

const DEFAULT_PROFILE_ID = 'default'

type GateContext = Pick<RpcContext, 'caller' | 'runtime'>

/** The profile a new tab gets for this worktree, as the renderer resolves it: repo pick, else the managed profile, else Default. */
async function expectedNewTabProfileId(
  context: GateContext,
  worktree: string | undefined
): Promise<string | null> {
  let found: { id: string; repoId?: string | null } | undefined
  try {
    found = worktree
      ? await context.runtime.showManagedWorktree(worktree, undefined, { matchFolders: true })
      : undefined
  } catch {
    // The command itself resolves the same selector and reports the real failure.
  }
  const worktreeId = found?.id
  // Why no catch: a repo we can't read might pick a listed profile, so its failure refuses the call.
  const repo: Repo | null = found?.repoId
    ? await context.runtime.showRepo(`id:${found.repoId}`)
    : null
  if (repo?.browserProfileId) {
    return repo.browserProfileId
  }
  const owner = worktreeId
    ? getManagedBrowserProfileOwner(
        context.runtime.requireStore().getSettings().browserProfileScope,
        worktreeId
      )
    : null
  if (!owner) {
    return DEFAULT_PROFILE_ID
  }
  // Managed profiles are made lazily; none yet means no list to protect.
  const { profiles } = await context.runtime.browserProfileList()
  return profiles.find((profile) => isManagedBrowserProfileOf(profile, owner))?.id ?? null
}

/** Pins an agent's new tab to the profile it would get anyway when that profile has a site list: headless and client placements would otherwise use the host default. */
async function pinAgentTabCreateToListedProfile<
  T extends { worktree?: string; profileId?: string }
>(context: GateContext, params: T): Promise<T> {
  if (!isAgentRpcCaller(context.caller)) {
    return params
  }
  const expected = await expectedNewTabProfileId(context, params.worktree)
  if (!expected || !browserProfileHasSiteList(expected)) {
    return params
  }
  assertAgentMayMoveBrowsingOut(expected, params.profileId ?? expected)
  return { ...params, profileId: expected }
}

/** Returns params naming the exact tab it checked, so the change can't land on another tab. */
export async function pinAgentTabProfileChange<T extends { worktree?: string; page?: string }>(
  context: GateContext,
  params: T,
  targetProfileId: string
): Promise<T> {
  if (!isAgentRpcCaller(context.caller)) {
    return params
  }
  const tab = params.page
    ? await context.runtime.browserTabProfileShow({ page: params.page, worktree: params.worktree })
    : (await context.runtime.browserTabCurrent({ worktree: params.worktree })).tab
  assertAgentMayMoveBrowsingOut(tab.profileId, targetProfileId)
  return { ...params, page: tab.browserPageId }
}

export function assertAgentMayDeleteProfile(context: GateContext, profileId: string): void {
  if (isAgentRpcCaller(context.caller)) {
    assertAgentMayLeaveProfile(profileId)
  }
}

export async function assertAgentMayChangeRepoBrowserProfile(
  context: GateContext,
  repo: string,
  updates: { browserProfileId?: string | null }
): Promise<void> {
  if (!isAgentRpcCaller(context.caller) || !('browserProfileId' in updates)) {
    return
  }
  const current = await context.runtime.showRepo(repo)
  for (const from of await currentRepoProfileIds(context, current)) {
    assertAgentMayMoveBrowsingOut(from, updates.browserProfileId)
  }
}

/** Where the repo's new tabs go now: its pick, else the managed profiles of its workspaces (none made yet means nothing to protect), else Default. */
async function currentRepoProfileIds(context: GateContext, repo: Repo): Promise<string[]> {
  if (repo.browserProfileId) {
    return [repo.browserProfileId]
  }
  const scope = context.runtime.requireStore().getSettings().browserProfileScope
  if (scope !== 'repo' && scope !== 'worktree') {
    return [DEFAULT_PROFILE_ID]
  }
  const { profiles } = await context.runtime.browserProfileList()
  return profiles
    .filter(
      (profile) =>
        profile.owner?.kind === scope &&
        (scope === 'repo' ? profile.owner.id : getRepoIdFromWorktreeId(profile.owner.id)) ===
          repo.id
    )
    .map((profile) => profile.id)
}

export async function createBrowserTabForCaller(
  params: Parameters<RpcContext['runtime']['browserTabCreate']>[0],
  context: RpcContext
): ReturnType<RpcContext['runtime']['browserTabCreate']> {
  const { runtime, pairedDeviceId, clientKind, signal } = context
  const pinned = await pinAgentTabCreateToListedProfile(context, params)
  return pairedDeviceId
    ? runtime.browserTabCreate(pinned, { pairedDeviceId, clientKind, signal })
    : runtime.browserTabCreate(pinned, { clientKind, signal })
}

/** openUrl always opens in the Default profile, so a worktree whose new tabs belong in a listed profile can't use it. */
export async function openBrowserUrlForCaller(
  params: Parameters<RpcContext['runtime']['browserOpenUrlOnClient']>[0],
  context: RpcContext
): ReturnType<RpcContext['runtime']['browserOpenUrlOnClient']> {
  const expected = isAgentRpcCaller(context.caller)
    ? await expectedNewTabProfileId(context, params.worktree)
    : null
  if (expected) {
    assertAgentMayMoveBrowsingOut(expected, DEFAULT_PROFILE_ID)
  }
  return context.runtime.browserOpenUrlOnClient(params, { signal: context.signal })
}
