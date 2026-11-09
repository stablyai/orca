import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime/remote-runtime-client-error-classification'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CrossStoreParentRef } from '../../shared/worktree/lineage-types'
import { crossStoreParentRefOfRow } from '../../shared/worktree/lineage-row-identity'
import {
  supportsCrossStoreLineage,
  WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY
} from '../../shared/worktree-runtime-capabilities'
import { getOptionalParentSelector } from '../caller-folder-workspace'
import { getOptionalStringFlag } from '../flags'
import { mayNameFolderWorkspace } from '../folder-workspace-selector'
import { isLocalEnvironmentSelector, LOCAL_ENVIRONMENT } from '../local-environment-selector'
import { RuntimeClient, RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { describeClientServer, serverLabel } from '../row-owner-server'
import { attachCliErrorData } from './worktree-setup-decision-recovery'

/** The server a parent lives on: `local` or a saved server's id. */
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
      `--parent-server ${value} is ambiguous: ${byName.length} saved servers have that name. Use the server id.`,
      { nextSteps: byName.map((environment) => `--parent-server ${environment.id}`) }
    )
  }
  throw new RuntimeClientError(
    'server_not_saved',
    `--parent-server ${value} is not a saved server here, so its workspaces can't be reached from here.`,
    {
      server: value,
      knownServers: saved.map(({ id, name }) => ({ id, name })),
      nextSteps: [
        "Pass local, or a saved server's id or name from `orca server list`.",
        'Save it first with `orca server add --name <name> --pairing-code <code>`.'
      ]
    }
  )
}

/**
 * Which server `--parent-worktree` names, when that differs from the child's. Undefined keeps
 * same-server parents. A caller-relative parent (active/current) is always on the caller's own
 * Orca, so against another server it is implicitly `local`.
 */
export function resolveParentEnvironment(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): ParentEnvironment | undefined {
  const parentSelector = getOptionalStringFlag(flags, 'parent-worktree')
  const value = getOptionalStringFlag(flags, 'parent-server')
  if (flags.has('parent-server')) {
    if (value === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --parent-server')
    }
    if (flags.get('no-parent') === true || !parentSelector) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--parent-server says which server holds --parent-worktree; pass it with --parent-worktree, not with --no-parent or alone.'
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
      `--parent-worktree ${parentSelector} names the workspace containing this terminal or cwd, which is on the Orca on this computer, not ${named.name}.`,
      {
        nextSteps: [
          'Drop --parent-server, or pass --parent-server local.',
          `For a workspace on ${named.name}, list it with \`orca worktree ps --server ${quoteCliCommandArgument(named.route)} --json\` and pass its address.worktree as --parent-worktree.`
        ]
      }
    )
  }
  const parentEnvironment = named ?? (isCallerRelative(parentSelector) ? LOCAL : undefined)
  return parentEnvironment && parentEnvironment.route !== describeClientServer(client).id
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
  const server = describeClientServer(client)
  throw new RuntimeClientError(
    'incompatible_runtime',
    `Update Orca on ${serverLabel(server)} to nest workspaces under a parent on another server. Nothing was changed.`,
    { server: server.id, requires: WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY }
  )
}

function unavailableError(error: unknown, environment: ParentEnvironment): unknown {
  if (!(error instanceof RuntimeClientError) || !isRecoverableRemoteRuntimeConnectionError(error)) {
    return error
  }
  return new RuntimeClientError(
    'server_unavailable',
    `${environment.name} didn't answer, so the parent couldn't be checked. Nothing was changed. (${error.message})`,
    {
      server: environment.route,
      nextSteps: [`orca status --server ${quoteCliCommandArgument(environment.route)} --json`]
    }
  )
}

type ParentLookupCode = 'LINEAGE_PARENT_NOT_FOUND' | 'LINEAGE_PARENT_AMBIGUOUS'

function isParentLookupCode(code: string): code is ParentLookupCode {
  return code === 'LINEAGE_PARENT_NOT_FOUND' || code === 'LINEAGE_PARENT_AMBIGUOUS'
}

/** The lineage code for a parent lookup's own error, as the server reports an explicit parent. */
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
 * Error data for a parent miss or ambiguity: the server searched, and recovery that lists that
 * server. Inherited steps are dropped because they inspect the caller's default route.
 */
function searchedEnvironmentData(
  error: RuntimeClientError,
  code: ParentLookupCode,
  environment: { route: string | null; name: string },
  extraSteps: readonly string[] = []
): Record<string, unknown> {
  const list = environment.route
    ? `orca worktree ps --server ${quoteCliCommandArgument(environment.route)} --json`
    : undefined
  const listStep = list
    ? code === 'LINEAGE_PARENT_AMBIGUOUS'
      ? `Compare the choices with \`${list}\`, then pass one as --parent-worktree.`
      : list
    : 'This one-off connection has no listing route; save it with `orca server add --name <name> --pairing-code <code>`, then run `orca worktree ps --server <name> --json`.'
  return {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    server: environment.route,
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
      ? `No workspace on ${environment.name} matched the parent selector. Nothing was changed; no other server was searched.`
      : `${error.message} (on ${environment.name}; nothing was changed)`
  return new RuntimeClientError(code, message, searchedEnvironmentData(error, code, environment))
}

/**
 * The verified ref a child saves for a parent on another server, built as the app builds it:
 * the parent store's own installationId plus the parent row's identity. No other server is
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
        `Update Orca on ${environment.name} so workspaces on other servers can name it as a parent. Nothing was changed.`,
        {
          server: environment.route,
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

/** Sends a create/set; a miss or ambiguity on its same-server parent names where it looked
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
    const environment = describeClientServer(client)
    throw attachCliErrorData(
      error,
      searchedEnvironmentData(
        error,
        code,
        { route: environment.id, name: serverLabel(environment) },
        code === 'LINEAGE_PARENT_NOT_FOUND'
          ? [
              `Only ${serverLabel(environment)} was searched for "${parentSelector}". For a parent on another server, add --parent-server <local|server-id> (a row's address.server from \`orca worktree ps --server <id> --json\`).`
            ]
          : []
      )
    )
  }
}
