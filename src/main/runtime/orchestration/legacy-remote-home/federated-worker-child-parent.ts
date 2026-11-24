import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationEntryCaller } from '../addressing/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration-error'
import { readCallerStoreInstallationId } from '../../hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { isInBotHome } from '../../../bots/bot-home-membership'
import { resolveDispatchCallerWorktreeId } from '../../rpc/methods/orchestration/orchestration-caller-workspace'

/**
 * The parent a `--on <server>` worktree nests under on this machine: the coordinator's workspace
 * for `new-child`, and for any create from a bot's home, as a local create there is the bot's
 * (`botCreatedLineage`). Other `new-top-level` starts get none. A server without cross-machine
 * parents still gets the worker, as a top-level worktree with a warning.
 */
export async function resolveFederatedChildParent(args: {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
    | 'showManagedWorktree'
    | 'resolveCallerParentForAnotherStore'
    | 'getRuntimeId'
    | 'bots'
  >
  worktree: 'new-child' | 'new-top-level'
  from: string
  callerSession: OrchestrationEntryCaller | undefined
  serverCapabilities: readonly string[] | undefined
  serverName: string
}): Promise<
  | { crossStoreParent: CrossStoreParentRef; crossStoreParentInferredFrom: 'orchestration-context' }
  | { warning: string }
  | undefined
> {
  const { runtime } = args
  const topLevel = args.worktree === 'new-top-level'
  if (topLevel && runtime.bots.list().length === 0) {
    return undefined
  }
  // Orchestration's caller authority picks the workspace; the shared builder verifies and names it.
  // A caller it can't place starts top-level, as new-top-level always did.
  const callerId = await resolveDispatchCallerWorktreeId(
    runtime,
    args.from,
    args.callerSession
  ).catch((error: unknown) => {
    if (topLevel) {
      return undefined
    }
    throw error
  })
  if (
    callerId === undefined ||
    (topLevel && !isInBotHome(runtime.bots, { workspaceId: callerId }))
  ) {
    return undefined
  }
  const notNested = async (why: string) => {
    const name = await runtime
      .showManagedWorktree(`id:${callerId}`)
      .then((worktree) => worktree.displayName || worktree.id)
      .catch(() => callerId)
    return { warning: `Not nested under ${name}: ${why}, so the worktree was created top-level.` }
  }
  if (!supportsCrossStoreLineage(args.serverCapabilities)) {
    return notNested(`${args.serverName} needs an Orca update to nest across machines`)
  }
  const resolved = await runtime.resolveCallerParentForAnotherStore(
    { envParentWorkspace: `id:${callerId}` },
    await readCallerStoreInstallationId(runtime.getRuntimeId(), getCanonicalUserDataPath())
  )
  if ('reason' in resolved) {
    // A bot asked for no parent; pointing it at new-top-level would only repeat this.
    if (topLevel) {
      return notNested(resolved.reason.replace(/\.$/, ''))
    }
    throw new OrchestrationError(
      'invalid_argument',
      `--worktree new-child can't nest under this workspace: ${resolved.reason} Use --worktree new-top-level.`
    )
  }
  return {
    crossStoreParent: resolved.parent,
    crossStoreParentInferredFrom: 'orchestration-context'
  }
}

/** The attach fields for a resolved parent; older servers strip the source and record a CLI parent. */
export function federatedAttachParent(
  childParent: Awaited<ReturnType<typeof resolveFederatedChildParent>>
): {
  crossStoreParent?: CrossStoreParentRef
  crossStoreParentInferredFrom?: 'orchestration-context'
} {
  return childParent && 'crossStoreParent' in childParent
    ? {
        crossStoreParent: childParent.crossStoreParent,
        crossStoreParentInferredFrom: childParent.crossStoreParentInferredFrom
      }
    : {}
}
