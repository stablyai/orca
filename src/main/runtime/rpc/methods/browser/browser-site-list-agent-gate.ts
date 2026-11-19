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
import type { Repo } from '../../../../../shared/repository/repo-types'

type GateContext = Pick<RpcContext, 'caller' | 'runtime'>

async function repoForWorktree(context: GateContext, worktree: string): Promise<Repo | null> {
  try {
    const { repoId } = await context.runtime.showManagedWorktree(worktree, undefined, {
      matchFolders: true
    })
    return repoId ? await context.runtime.showRepo(`id:${repoId}`) : null
  } catch {
    // The command itself resolves the same selector and reports the real failure.
    return null
  }
}

/** Pins an agent's new tab to the repo's listed profile: headless and client placements would otherwise use the host default. */
async function pinAgentTabCreateToListedProfile<
  T extends { worktree?: string; profileId?: string }
>(context: GateContext, params: T): Promise<T> {
  if (!isAgentRpcCaller(context.caller) || !params.worktree) {
    return params
  }
  const repoProfileId = (await repoForWorktree(context, params.worktree))?.browserProfileId
  if (!repoProfileId || !browserProfileHasSiteList(repoProfileId)) {
    return params
  }
  assertAgentMayMoveBrowsingOut(repoProfileId, params.profileId ?? repoProfileId)
  return { ...params, profileId: repoProfileId }
}

export async function assertAgentMayChangeTabProfile(
  context: GateContext,
  params: { worktree?: string; page?: string },
  targetProfileId: string
): Promise<void> {
  if (!isAgentRpcCaller(context.caller)) {
    return
  }
  const tab = params.page
    ? await context.runtime.browserTabProfileShow({ page: params.page, worktree: params.worktree })
    : (await context.runtime.browserTabCurrent({ worktree: params.worktree })).tab
  assertAgentMayMoveBrowsingOut(tab.profileId, targetProfileId)
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
  const current = (await context.runtime.showRepo(repo)).browserProfileId
  assertAgentMayMoveBrowsingOut(current, updates.browserProfileId)
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
