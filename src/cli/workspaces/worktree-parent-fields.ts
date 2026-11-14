import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type {
  CrossStoreInferredSource,
  CrossStoreParentRef
} from '../../shared/worktree/lineage-types'
import {
  assertFolderParentSetSupported,
  supportsCrossStoreLineage
} from '../../shared/worktree-runtime-capabilities'
import { getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { resolveWorktreeCreateCwdContext } from '../workspace-selection/workspace-selector'
import { mayNameFolderWorkspace } from '../workspace-selection/folder-workspace-selector'
import { parentCwdNextSteps, withWorktreeSelectorRecovery } from './worktree-selector-recovery'
import { getOptionalParentSelector } from '../workspace-selection/caller-folder-workspace'
import type { CreateParentSelector } from './worktree-create-parent-selector'
import {
  resolveCrossEnvironmentParent,
  resolveParentEnvironment
} from './worktree-parent-environment'

const CALLER_PARENT_INFERENCE_BUDGET_MS = 3_000

/** This machine's own Orca, where a caller-relative parent (active, current, this terminal) lives. */
export function callerOrcaClient(client: RuntimeClient): RuntimeClient {
  return client.isRemote ? new RuntimeClient(client.userDataPath, undefined, null, null) : client
}

function serverLabel(client: RuntimeClient): string {
  return client.environmentSelector ?? 'the connected server'
}

/** `worktree create`'s parent fields. A parent in another environment (--parent-environment, or
 * active/current against a server) is sent as a verified cross-store ref; with no parent flag, the
 * caller's own workspace is inferred on this machine's Orca. */
export async function resolveCreateParentFields(
  client: RuntimeClient,
  args: {
    explicitParent: CreateParentSelector
    inferredParent: string | undefined
    cwd: string
    flags: Map<string, string | boolean>
    cwdContext: { parentWorktree?: { selector: string }; parentAmbiguous?: true }
    callerTerminalHandle: string | undefined
    noParent: boolean
  }
): Promise<Record<string, unknown>> {
  const { explicitParent, inferredParent, cwdContext, noParent } = args
  if (explicitParent.parentEnvironment) {
    const crossStoreParent = await resolveCrossEnvironmentParent(client, {
      flags: args.flags,
      cwd: args.cwd,
      environment: explicitParent.parentEnvironment
    })
    return { crossStoreParent, noParent }
  }
  const targetParent = {
    parentWorktree: explicitParent.parentWorktree,
    // The runtime classifies path:/name: parents by kind; older runtimes strip this.
    ...(explicitParent.parentWorktree && mayNameFolderWorkspace(explicitParent.parentWorktree)
      ? { matchFolderWorkspaces: true }
      : {}),
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
  // Optional nesting must not hold up the server create behind a stalled Orca on this machine.
  const startedAt = Date.now()
  const local = new RuntimeClient(
    client.userDataPath,
    CALLER_PARENT_INFERENCE_BUDGET_MS,
    null,
    null
  )
  let localTimedOut = false
  // No Orca running here, or cwd outside its workspaces: no cwd context.
  const cwdContext = await resolveWorktreeCreateCwdContext(cwd, local, false).catch(
    (error: unknown): Awaited<ReturnType<typeof resolveWorktreeCreateCwdContext>> => {
      localTimedOut = error instanceof RuntimeClientError && error.code === 'runtime_timeout'
      return {}
    }
  )
  if (!context.envParentWorkspace && !context.callerTerminalHandle && !cwdContext.parentWorktree) {
    return {}
  }
  const notNested = (reason: string): Record<string, unknown> => {
    console.error(`note: not nested: ${reason}`)
    return { noParent: true }
  }
  // The budget is this machine's: time spent on the server's status doesn't count.
  const remainingMs = CALLER_PARENT_INFERENCE_BUDGET_MS - (Date.now() - startedAt)
  if (localTimedOut || remainingMs <= 0) {
    return notNested("this machine's Orca didn't answer in time.")
  }
  try {
    const status = (await client.call<RuntimeStatus>('status.get')).result
    if (!supportsCrossStoreLineage(status.capabilities)) {
      return notNested(`${serverLabel(client)} needs an Orca update to nest across machines.`)
    }
    const resolved = (
      await local.call<
        { parent: CrossStoreParentRef; source: CrossStoreInferredSource } | { reason: string }
      >(
        'worktree.resolveCallerParent',
        {
          ...context,
          cwdParentWorktree: cwdContext.parentWorktree?.selector,
          ...(cwdContext.parentAmbiguous ? { cwdParentAmbiguous: true } : {})
        },
        { timeoutMs: remainingMs }
      )
    ).result
    if ('reason' in resolved) {
      return notNested(resolved.reason)
    }
    return { crossStoreParent: resolved.parent, crossStoreParentInferredFrom: resolved.source }
  } catch (error) {
    return notNested(error instanceof Error ? error.message : String(error))
  }
}

/** `worktree set`'s parent; one in another environment is sent as a verified cross-store ref. */
export async function resolveSetParentFields(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<{
  crossStoreParent?: CrossStoreParentRef
  parentWorktree?: string
  matchFolderWorkspaces?: true
}> {
  const environment = resolveParentEnvironment(flags, client)
  if (environment) {
    return {
      crossStoreParent: await resolveCrossEnvironmentParent(client, { flags, cwd, environment })
    }
  }
  const raw = getOptionalStringFlag(flags, 'parent-worktree')
  const rawKey = raw?.startsWith('id:') ? raw.slice('id:'.length) : raw
  if (rawKey && parseWorkspaceKey(rawKey)?.type === 'folder') {
    return { parentWorktree: await assertFolderParentSetSupportedBy(client, rawKey) }
  }
  const parentWorktree = await withWorktreeSelectorRecovery(
    getOptionalParentSelector(flags, cwd, client),
    parentCwdNextSteps(raw),
    raw
  )
  if (parentWorktree && parseWorkspaceKey(parentWorktree)?.type === 'folder') {
    return { parentWorktree: await assertFolderParentSetSupportedBy(client, parentWorktree) }
  }
  return parentWorktree && mayNameFolderWorkspace(parentWorktree)
    ? { parentWorktree, matchFolderWorkspaces: true }
    : { parentWorktree }
}

/** An older host refuses a folder parent as "not found"; say it needs an update instead. */
async function assertFolderParentSetSupportedBy(
  client: RuntimeClient,
  folderKey: string
): Promise<string> {
  const status = (await client.call<RuntimeStatus>('status.get')).result
  assertFolderParentSetSupported(status.capabilities, client.environmentSelector ?? 'this machine')
  return folderKey
}
