import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import { assertCrossStoreLineageSupported } from '../../shared/worktree-runtime-capabilities'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'
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
  assertCrossStoreLineageSupported(
    status.capabilities,
    client.environmentSelector ?? 'the connected server'
  )
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

/** `worktree create`'s parent fields. Explicit active/current against a server is a parent on this
 * machine. Only an explicit request crosses machines: this machine's terminal, cwd and env context
 * names nothing on the server, so it is never sent there, where it could match a same-store twin. */
export async function resolveCreateParentFields(
  client: RuntimeClient,
  args: {
    explicitParent: { parentWorktree?: string; parentWorkspace?: string; onCallerMachine?: true }
    inferredParent: string | undefined
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
    if (inferredParent) {
      await printNotNestedNote(client, inferredParent)
    }
    return targetParent
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

async function printNotNestedNote(client: RuntimeClient, workspaceKey: string): Promise<void> {
  const scope = parseWorkspaceKey(workspaceKey)
  const name = await callerOrcaClient(client)
    .call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: scope?.type === 'worktree' ? `id:${scope.worktreeId}` : workspaceKey
    })
    .then((shown) => shown.result.worktree.displayName || workspaceKey)
    .catch(() => workspaceKey)
  console.error(
    `note: not nested. Add --parent-worktree active to nest it under ${name} on this machine.`
  )
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
