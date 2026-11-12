import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime/remote-runtime-client-error-classification'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import { crossStoreParentRefOfRow } from '../../shared/worktree/lineage-row-identity'
import {
  supportsCrossStoreLineage,
  WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY
} from '../../shared/worktree-runtime-capabilities'
import { getOptionalParentSelector } from '../workspace-selection/caller-folder-workspace'
import { getOptionalStringFlag } from '../flags'
import { mayNameFolderWorkspace } from '../workspace-selection/folder-workspace-selector'
import { isLocalEnvironmentSelector, LOCAL_ENVIRONMENT } from '../hosts/local-environment-selector'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { describeClientEnvironment, environmentLabel } from './workspace-address'
import { attachCliErrorData } from './worktree-setup-decision-recovery'

/** The Orca a parent lives in: `local` or a saved environment's id. */
export type ParentEnvironment = { route: string; name: string }

const LOCAL: ParentEnvironment = { route: LOCAL_ENVIRONMENT, name: LOCAL_ENVIRONMENT }

function isCallerRelative(selector: string | undefined): boolean {
  return selector === 'active' || selector === 'current'
}

function savedParentEnvironment(userDataPath: string, value: string): ParentEnvironment {
  const saved = listEnvironments(userDataPath)
  const byId = saved.find((environment) => environment.id === value)
  const byName = saved.filter((environment) => environment.name === value)
  const found = byId ?? (byName.length === 1 ? byName[0] : undefined)
  if (found) {
    return { route: found.id, name: found.name }
  }
  if (byName.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--parent-environment ${value} is ambiguous: ${byName.length} saved environments have that name. Use the environment id.`,
      { nextSteps: byName.map((environment) => `--parent-environment ${environment.id}`) }
    )
  }
  throw new RuntimeClientError(
    'environment_not_paired',
    `--parent-environment ${value} is not a saved environment here, so its workspaces can't be reached from this machine.`,
    {
      environment: value,
      knownEnvironments: saved.map(({ id, name }) => ({ id, name })),
      nextSteps: [
        'Pass local, or the id or name of a saved environment from `orca environment list`.',
        'Pair it first with `orca environment add --name <name> --pairing-code <code>`.'
      ]
    }
  )
}

/**
 * Which environment `--parent-worktree` names, when that differs from the child's. Undefined keeps
 * same-environment parents. A caller-relative parent (active/current) is always on the caller's own
 * Orca, so against another environment it is implicitly `local`.
 */
export function resolveParentEnvironment(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): ParentEnvironment | undefined {
  const parentSelector = getOptionalStringFlag(flags, 'parent-worktree')
  const value = getOptionalStringFlag(flags, 'parent-environment')
  if (flags.has('parent-environment')) {
    if (value === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --parent-environment')
    }
    if (flags.get('no-parent') === true || !parentSelector) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--parent-environment says where --parent-worktree lives; pass it with --parent-worktree, not with --no-parent or alone.'
      )
    }
  }
  const named = value
    ? isLocalEnvironmentSelector(value)
      ? LOCAL
      : savedParentEnvironment(client.userDataPath, value)
    : undefined
  if (isCallerRelative(parentSelector) && named && named.route !== LOCAL_ENVIRONMENT) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--parent-worktree ${parentSelector} names the workspace containing this terminal or cwd, which is on this machine's own Orca, not ${named.name}.`,
      {
        nextSteps: [
          `Drop --parent-environment, or pass --parent-environment local.`,
          `For a workspace in ${named.name}, list it with \`orca worktree ps --environment ${quoteCliCommandArgument(named.route)} --json\` and pass its address.worktree as --parent-worktree.`
        ]
      }
    )
  }
  const parentEnvironment = named ?? (isCallerRelative(parentSelector) ? LOCAL : undefined)
  return parentEnvironment && parentEnvironment.route !== describeClientEnvironment(client).id
    ? parentEnvironment
    : undefined
}

function parentEnvironmentClient(
  client: RuntimeClient,
  environment: ParentEnvironment
): RuntimeClient {
  return new RuntimeClient(
    client.userDataPath,
    undefined,
    null,
    environment.route === LOCAL_ENVIRONMENT ? null : environment.route
  )
}

/** Refuses before any request: an older child Orca would apply the rest and drop the parent. */
async function assertChildSavesCrossStoreParents(client: RuntimeClient): Promise<void> {
  const status = (await client.call<RuntimeStatus>('status.get')).result
  if (supportsCrossStoreLineage(status.capabilities)) {
    return
  }
  const environment = describeClientEnvironment(client)
  throw new RuntimeClientError(
    'incompatible_runtime',
    `Update Orca in ${environmentLabel(environment)} to nest workspaces under a parent in another environment. Nothing was changed.`,
    { environment: environment.id, requires: WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY }
  )
}

function unavailableError(error: unknown, environment: ParentEnvironment): unknown {
  if (!(error instanceof RuntimeClientError) || !isRecoverableRemoteRuntimeConnectionError(error)) {
    return error
  }
  return new RuntimeClientError(
    'environment_unavailable',
    `${environment.name} didn't answer, so the parent couldn't be checked. Nothing was changed. (${error.message})`,
    {
      environment: environment.route,
      nextSteps: [`orca status --environment ${quoteCliCommandArgument(environment.route)} --json`]
    }
  )
}

type ParentLookupCode = 'LINEAGE_PARENT_NOT_FOUND' | 'LINEAGE_PARENT_AMBIGUOUS'

function isParentLookupCode(code: string): code is ParentLookupCode {
  return code === 'LINEAGE_PARENT_NOT_FOUND' || code === 'LINEAGE_PARENT_AMBIGUOUS'
}

/** The lineage code for a parent lookup's own error, as the runtime reports an explicit parent. */
function parentLookupCode(error: RuntimeClientError): ParentLookupCode | undefined {
  if (isParentLookupCode(error.code)) {
    return error.code
  }
  return error.code === 'selector_not_found'
    ? 'LINEAGE_PARENT_NOT_FOUND'
    : error.code === 'selector_ambiguous'
      ? 'LINEAGE_PARENT_AMBIGUOUS'
      : undefined
}

/**
 * Error data for a parent miss or ambiguity: the environment searched, and recovery that lists that
 * environment. Inherited steps are dropped because they inspect the caller's default route.
 */
function searchedEnvironmentData(
  error: RuntimeClientError,
  code: ParentLookupCode,
  environment: { route: string | null; name: string },
  extraSteps: readonly string[] = []
): Record<string, unknown> {
  const list = environment.route
    ? `orca worktree ps --environment ${quoteCliCommandArgument(environment.route)} --json`
    : undefined
  const listStep = list
    ? code === 'LINEAGE_PARENT_AMBIGUOUS'
      ? `Compare the choices with \`${list}\`, then pass one as --parent-worktree.`
      : list
    : 'This one-off connection has no listing route; save it with `orca environment add --name <name> --pairing-code <code>`, then run `orca worktree ps --environment <name> --json`.'
  return {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    environment: environment.route,
    nextSteps: [listStep, ...extraSteps]
  }
}

function parentLookupError(error: unknown, environment: ParentEnvironment): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  const code = parentLookupCode(error)
  if (!code) {
    return error
  }
  const message =
    code === 'LINEAGE_PARENT_NOT_FOUND'
      ? `No workspace in ${environment.name} matched the parent selector. Nothing was changed; no other environment was searched.`
      : `${error.message} (in ${environment.name}; nothing was changed)`
  return new RuntimeClientError(code, message, searchedEnvironmentData(error, code, environment))
}

/**
 * The verified ref a child saves for a parent in another environment, built as the app builds it:
 * the parent store's own installationId plus the parent row's identity. No other environment is
 * searched, and every check runs before the child is changed.
 */
export async function resolveCrossEnvironmentParent(
  client: RuntimeClient,
  args: { flags: Map<string, string | boolean>; cwd: string; environment: ParentEnvironment }
): Promise<CrossStoreParentRef> {
  const { flags, cwd, environment } = args
  await assertChildSavesCrossStoreParents(client)
  const parentClient = parentEnvironmentClient(client, environment)
  try {
    const raw = getOptionalStringFlag(flags, 'parent-worktree') ?? ''
    // active/current keep their own cwd recovery; only an explicit selector's miss is the parent's.
    const selector = isCallerRelative(raw)
      ? ((await getOptionalParentSelector(flags, cwd, parentClient)) ?? raw)
      : raw
    const parent = await parentClient
      .call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: selector,
        ...(mayNameFolderWorkspace(selector) ? { matchFolderWorkspaces: true } : {})
      })
      .catch((error: unknown) => {
        throw parentLookupError(error, environment)
      })
    const { installationId } = (
      await parentClient.call<{ installationId?: string }>('worktree.lineageList')
    ).result
    const ref = crossStoreParentRefOfRow(installationId, parent.result.worktree)
    if (!installationId) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        `Update Orca in ${environment.name} so workspaces in other environments can name it as a parent. Nothing was changed.`,
        {
          environment: environment.route,
          requires: WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY
        }
      )
    }
    if (!ref) {
      throw new RuntimeClientError(
        'invalid_argument',
        "Couldn't confirm the parent's workspace identity. Refresh it in the Orca app and try again."
      )
    }
    return ref
  } catch (error) {
    throw unavailableError(error, environment)
  }
}

/** Sends a create/set; a miss or ambiguity on its same-environment parent names where it looked
 * and how to list it, and a miss says how to name a parent elsewhere. */
export async function callNamingParentEnvironment<
  T,
  Params extends { parentWorktree?: string; parentWorkspace?: string; crossStoreParent?: unknown } =
    Record<string, unknown>
>(
  client: RuntimeClient,
  method: 'worktree.create' | 'worktree.set',
  params: Params
): Promise<RuntimeRpcSuccess<T>> {
  try {
    return await client.call<T>(method, params)
  } catch (error) {
    const parentSelector = params.parentWorktree ?? params.parentWorkspace
    // A selector_* error here may be the child's own selector; only lineage codes name the parent.
    if (
      !(error instanceof RuntimeClientError) ||
      !isParentLookupCode(error.code) ||
      !parentSelector ||
      params.crossStoreParent
    ) {
      throw error
    }
    const code = error.code
    const environment = describeClientEnvironment(client)
    throw attachCliErrorData(
      error,
      searchedEnvironmentData(
        error,
        code,
        { route: environment.id, name: environmentLabel(environment) },
        code === 'LINEAGE_PARENT_NOT_FOUND'
          ? [
              `Only ${environmentLabel(environment)} was searched for "${parentSelector}". For a parent in another environment, add --parent-environment <local|environment-id> (a row's address.environment from \`orca worktree ps --environment <id> --json\`).`
            ]
          : []
      )
    )
  }
}
