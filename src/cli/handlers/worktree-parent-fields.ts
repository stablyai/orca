import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import {
  assertCrossStoreLineageSupported,
  supportsCrossStoreLineage
} from '../../shared/worktree-runtime-capabilities'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveWorktreeCreateCwdContext } from '../selectors'
import { parentCwdNextSteps, withWorktreeSelectorRecovery } from '../worktree-selector-recovery'

/** This machine's own Orca, where a caller-relative parent (active, current, this terminal) lives. */
export function callerOrcaClient(client: RuntimeClient): RuntimeClient {
  return client.isRemote ? new RuntimeClient(client.userDataPath, undefined, null, null) : client
}

/**
 * A parent on this machine for a workspace on the connected server. The server must advertise the
 * capability before anything is sent (an older one would apply the rest and drop the parent); this
 * desktop's Orca supplies its own installationId and the parent row's identity.
 */
async function resolveCallerCrossStoreParent(
  client: RuntimeClient,
  selector: string | undefined
): Promise<CrossStoreParentRef | undefined> {
  if (!selector) {
    return undefined
  }
  const status = (await client.call<RuntimeStatus>('status.get')).result
  assertCrossStoreLineageSupported(status.capabilities, serverLabel(client))
  return await readCallerParentRef(client, selector)
}

async function readCallerParentRef(
  client: RuntimeClient,
  selector: string
): Promise<CrossStoreParentRef> {
  const local = callerOrcaClient(client)
  const parent = (
    await local.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', { worktree: selector })
  ).result.worktree
  const { installationId } = (await local.call<{ installationId?: string }>('worktree.lineageList'))
    .result
  if (isWorkspaceKey(parent.id) || !parent.instanceId || !installationId) {
    throw new RuntimeClientError(
      'invalid_argument',
      isWorkspaceKey(parent.id)
        ? "A folder workspace can't parent a workspace on another machine yet."
        : "Couldn't confirm the parent's machine or workspace identity. Refresh it and try again."
    )
  }
  return {
    installationId,
    workspaceKey: worktreeWorkspaceKey(parent.id),
    instanceId: parent.instanceId
  }
}

function serverLabel(client: RuntimeClient): string {
  return client.environmentSelector ?? 'the connected server'
}

/** `worktree create`'s parent fields. Explicit active/current against a server is a parent on this
 * machine; with no parent flag, the caller's own workspace there is inferred the same way. */
export async function resolveCreateParentFields(
  client: RuntimeClient,
  args: {
    explicitParent: { parentWorktree?: string; parentWorkspace?: string; onCallerMachine?: true }
    inferredParent: string | undefined
    cwd: string
    cwdContext: { parentWorktree?: { selector: string }; parentAmbiguous?: true }
    callerTerminalHandle: string | undefined
    noParent: boolean
  }
): Promise<Record<string, unknown>> {
  const { explicitParent, inferredParent, cwdContext, noParent } = args
  if (explicitParent.onCallerMachine) {
    const crossStoreParent = await resolveCallerCrossStoreParent(
      client,
      explicitParent.parentWorktree
    )
    return { crossStoreParent, noParent }
  }
  const targetParent = {
    parentWorktree: explicitParent.parentWorktree,
    ...(explicitParent.parentWorkspace ? { parentWorkspace: explicitParent.parentWorkspace } : {}),
    noParent
  }
  if (client.isRemote) {
    const inferParent =
      !explicitParent.parentWorktree && !explicitParent.parentWorkspace && !noParent
    return {
      ...targetParent,
      ...(inferParent ? await inferCallerCrossStoreParent(client, inferredParent, args.cwd) : {})
    }
  }
  return {
    ...targetParent,
    ...(inferredParent ? { envParentWorkspace: inferredParent } : {}),
    ...(cwdContext.parentWorktree ? { cwdParentWorktree: cwdContext.parentWorktree.selector } : {}),
    // Older hosts ignore the observation and keep this first-row cwd parent.
    ...(cwdContext.parentAmbiguous ? { cwdParentAmbiguous: cwdContext.parentAmbiguous } : {}),
    callerTerminalHandle: args.callerTerminalHandle
  }
}

/** The caller's workspace on this machine (env, else cwd, as on the same machine) parents a create
 * on the server. Anything short of a verified link creates unnested with one note. */
async function inferCallerCrossStoreParent(
  client: RuntimeClient,
  envParentWorkspace: string | undefined,
  cwd: string
): Promise<Record<string, unknown>> {
  const caller = await findCallerWorkspace(client, envParentWorkspace, cwd)
  if (!caller) {
    return {}
  }
  try {
    const status = (await client.call<RuntimeStatus>('status.get')).result
    if (!supportsCrossStoreLineage(status.capabilities)) {
      await printNotNestedNote(
        client,
        caller.selector,
        `${serverLabel(client)} needs an Orca update to nest across machines.`
      )
      return {}
    }
    return {
      crossStoreParent: await readCallerParentRef(client, caller.selector),
      crossStoreParentInferredFrom: caller.source
    }
  } catch (error) {
    await printNotNestedNote(
      client,
      caller.selector,
      error instanceof Error ? error.message : String(error)
    )
    return {}
  }
}

async function findCallerWorkspace(
  client: RuntimeClient,
  envParentWorkspace: string | undefined,
  cwd: string
): Promise<{ selector: string; source: 'env-workspace' | 'cwd-context' } | undefined> {
  if (envParentWorkspace) {
    const scope = parseWorkspaceKey(envParentWorkspace)
    return {
      selector: scope?.type === 'worktree' ? `id:${scope.worktreeId}` : envParentWorkspace,
      source: 'env-workspace'
    }
  }
  // No Orca running here, or cwd outside its workspaces: nothing to infer.
  const cwdContext = await resolveWorktreeCreateCwdContext(
    cwd,
    callerOrcaClient(client),
    false
  ).catch(() => ({}) as Awaited<ReturnType<typeof resolveWorktreeCreateCwdContext>>)
  return cwdContext.parentWorktree && !cwdContext.parentAmbiguous
    ? { selector: cwdContext.parentWorktree.selector, source: 'cwd-context' }
    : undefined
}

async function printNotNestedNote(
  client: RuntimeClient,
  selector: string,
  reason: string
): Promise<void> {
  const name = await callerOrcaClient(client)
    .call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', { worktree: selector })
    .then((shown) => shown.result.worktree.displayName || selector)
    .catch(() => selector)
  console.error(`note: not nested under ${name}: ${reason}`)
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
    return { crossStoreParent: await resolveCallerCrossStoreParent(client, selector) }
  }
  return {
    parentWorktree: await withWorktreeSelectorRecovery(
      getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
      parentCwdNextSteps(raw),
      raw
    )
  }
}
