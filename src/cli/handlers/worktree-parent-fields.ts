import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import { assertCrossStoreLineageSupported } from '../../shared/worktree-runtime-capabilities'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'
import { parentCwdNextSteps, withWorktreeSelectorRecovery } from '../worktree-selector-recovery'

/** This machine's own Orca, where a caller-relative parent (active, current, this terminal) lives. */
export function callerOrcaClient(client: RuntimeClient): RuntimeClient {
  return client.isRemote ? new RuntimeClient(client.userDataPath, undefined, null, null) : client
}

/**
 * A parent on this machine for a workspace on the connected server. The server must advertise
 * the capability before anything is sent (an older one would apply the rest and drop the parent);
 * the parent's own Orca names it and its install. Explicit parents refuse; inferred ones warn and fall back.
 */
export async function resolveCallerCrossStoreParent(
  client: RuntimeClient,
  selector: string | undefined,
  options: { explicit: boolean; reparent: boolean }
): Promise<CrossStoreParentRef | undefined> {
  if (!selector || !client.isRemote) {
    return undefined
  }
  try {
    const status = (await client.call<RuntimeStatus>('status.get')).result
    assertCrossStoreLineageSupported(
      status.capabilities,
      client.environmentSelector ?? 'the connected server'
    )
    const minted = await callerOrcaClient(client).call<{ parent: CrossStoreParentRef }>(
      'worktree.crossStoreParentRef',
      { worktree: selector, ...(options.reparent ? { reparent: true } : {}) }
    )
    return minted.result.parent
  } catch (error) {
    if (options.explicit) {
      throw error
    }
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`warning: ${reason} Creating without a parent.`)
    return undefined
  }
}

/** `worktree create`'s parent fields. Explicit active/current against a server, or an inferred terminal
 * parent, is on this machine: sent as a cross-store parent, which the host takes over inferred ones. */
export async function resolveCreateParentFields(
  client: RuntimeClient,
  args: {
    explicitParent: { parentWorktree?: string; parentWorkspace?: string; onCallerMachine?: true }
    inferredParent: string | undefined
    cwdContext: { parentWorktree?: { selector: string }; parentAmbiguous?: true }
  }
): Promise<Record<string, unknown>> {
  const { explicitParent, inferredParent, cwdContext } = args
  const crossStoreParent = await resolveCallerCrossStoreParent(
    client,
    explicitParent.onCallerMachine ? explicitParent.parentWorktree : inferredParent,
    { explicit: explicitParent.onCallerMachine === true, reparent: false }
  )
  return {
    ...(crossStoreParent
      ? { crossStoreParent }
      : { parentWorktree: explicitParent.parentWorktree }),
    ...(explicitParent.parentWorkspace ? { parentWorkspace: explicitParent.parentWorkspace } : {}),
    ...(inferredParent ? { envParentWorkspace: inferredParent } : {}),
    ...(cwdContext.parentWorktree ? { cwdParentWorktree: cwdContext.parentWorktree.selector } : {}),
    // Older hosts ignore the observation and keep this first-row cwd parent.
    ...(cwdContext.parentAmbiguous ? { cwdParentAmbiguous: cwdContext.parentAmbiguous } : {})
  }
}

/** `worktree set`'s parent: active/current against a server names this machine's workspace. */
export async function resolveSetParentFields(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<{ crossStoreParent?: CrossStoreParentRef; parentWorktree?: string }> {
  const raw = getOptionalStringFlag(flags, 'parent-worktree')
  if (client.isRemote && (raw === 'active' || raw === 'current')) {
    const selector = await getOptionalWorktreeSelector(
      flags,
      'parent-worktree',
      cwd,
      callerOrcaClient(client)
    )
    const crossStoreParent = await resolveCallerCrossStoreParent(client, selector, {
      explicit: true,
      reparent: true
    })
    return { crossStoreParent }
  }
  return {
    parentWorktree: await withWorktreeSelectorRecovery(
      getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
      parentCwdNextSteps(raw),
      raw
    )
  }
}
