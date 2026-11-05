import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type {
  CrossStoreInferredSource,
  CrossStoreParentRef
} from '../../shared/worktree/lineage-types'
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
      ...(inferParent
        ? await inferCallerCrossStoreParent(
            client,
            { envParentWorkspace: inferredParent, callerTerminalHandle: args.callerTerminalHandle },
            args.cwd
          )
        : {})
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

/** No parent flag against a server: this machine's Orca resolves the caller's env, terminal and cwd
 * context exactly as its same-machine create would. Short of a valid parent it creates unnested with
 * one note, and noParent keeps the server's own create-time inference from nesting it anyway. */
async function inferCallerCrossStoreParent(
  client: RuntimeClient,
  context: { envParentWorkspace: string | undefined; callerTerminalHandle: string | undefined },
  cwd: string
): Promise<Record<string, unknown>> {
  const local = callerOrcaClient(client)
  // No Orca running here, or cwd outside its workspaces: no cwd context.
  const cwdContext = await resolveWorktreeCreateCwdContext(cwd, local, false).catch(
    (): Awaited<ReturnType<typeof resolveWorktreeCreateCwdContext>> => ({})
  )
  if (!context.envParentWorkspace && !context.callerTerminalHandle && !cwdContext.parentWorktree) {
    return {}
  }
  const notNested = (reason: string): Record<string, unknown> => {
    console.error(`note: not nested: ${reason}`)
    return { noParent: true }
  }
  try {
    const status = (await client.call<RuntimeStatus>('status.get')).result
    if (!supportsCrossStoreLineage(status.capabilities)) {
      return notNested(`${serverLabel(client)} needs an Orca update to nest across machines.`)
    }
    const resolved = (
      await local.call<
        { parent: CrossStoreParentRef; source: CrossStoreInferredSource } | { reason: string }
      >('worktree.resolveCallerParent', {
        ...context,
        cwdParentWorktree: cwdContext.parentWorktree?.selector,
        ...(cwdContext.parentAmbiguous ? { cwdParentAmbiguous: true } : {})
      })
    ).result
    if ('reason' in resolved) {
      return notNested(resolved.reason)
    }
    return { crossStoreParent: resolved.parent, crossStoreParentInferredFrom: resolved.source }
  } catch (error) {
    return notNested(error instanceof Error ? error.message : String(error))
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
