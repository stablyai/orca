import type { CommandHandler } from '../dispatch'
import { getOptionalNumberFlag, getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { resolveCurrentWorktreeSelector } from '../selectors'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { ResourceReservationRequest } from '../../shared/resource-reservation-binding'
import {
  assertResourceReservationSupported,
  getOptionalResourceReservation
} from '../resource-reservation-flags'
import {
  hasWorkspaceProjectTarget,
  resolveProjectCreateRepoSelector
} from '../worktree-project-target'
import { resolveCreateParentSelector } from './worktree-create-parent-selector'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'

type CliFlags = Map<string, string | boolean>
type CliClient = Parameters<CommandHandler>[0]['client']

function getEnvParentWorkspace(): string | undefined {
  const workspaceId = process.env.ORCA_WORKSPACE_ID
  if (typeof workspaceId === 'string' && isWorkspaceKey(workspaceId)) {
    return workspaceId
  }
  const worktreeId = process.env.ORCA_WORKTREE_ID
  if (typeof worktreeId === 'string' && worktreeId.length > 0) {
    return isWorkspaceKey(worktreeId) ? worktreeId : worktreeWorkspaceKey(worktreeId)
  }
  return undefined
}

export function getPresentStringFlag(
  flags: CliFlags,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && (options.allowEmpty || value.length > 0)) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

function getOptionalStartupAgent(flags: CliFlags): string | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    return undefined
  }
  if (!isTuiAgent(agent)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${agent}"`)
  }
  return agent
}

function getOptionalSetupDecision(flags: CliFlags): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true) {
    if (setup !== undefined && setup !== 'run') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose either --run-hooks or --setup run, not contradictory setup flags.'
      )
    }
    return setup
  }
  return setup
}

function getRepoSelectorFromWorktreeSelector(selector: string | undefined): string | undefined {
  if (!selector?.startsWith('id:')) {
    return undefined
  }
  const worktreeId = selector.slice('id:'.length)
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

async function getCreateRepoSelector(
  flags: CliFlags,
  cwdParentWorktree: string | undefined,
  client: CliClient
): Promise<string> {
  const projectRepoSelector = await resolveProjectCreateRepoSelector(flags, client)
  if (projectRepoSelector) {
    return projectRepoSelector
  }
  const explicitRepo = getPresentStringFlag(flags, 'repo')
  if (explicitRepo) {
    return explicitRepo
  }
  const inferredRepo = getRepoSelectorFromWorktreeSelector(cwdParentWorktree)
  if (inferredRepo) {
    return inferredRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.'
  )
}

/** Assembles the `worktree.create` wire params, including the caller reservation when one was
 *  passed. The reservation is reported back so the caller can verify the host echoed it. */
export async function buildWorktreeCreateParams(args: {
  flags: CliFlags
  client: CliClient
  cwd: string
}): Promise<{ params: Record<string, unknown>; reservation?: ResourceReservationRequest }> {
  const { flags, client, cwd } = args
  const callerTerminalHandle =
    typeof process.env.ORCA_TERMINAL_HANDLE === 'string' &&
    process.env.ORCA_TERMINAL_HANDLE.length > 0
      ? process.env.ORCA_TERMINAL_HANDLE
      : undefined
  const explicitParent = await resolveCreateParentSelector(flags, cwd, client)
  const explicitParentWorktree = explicitParent.parentWorktree
  const explicitParentWorkspace = explicitParent.parentWorkspace
  const startupAgent = getOptionalStartupAgent(flags)
  const setupDecision = getOptionalSetupDecision(flags)
  const noParent = flags.get('no-parent') === true
  const envParentWorkspace =
    !noParent && !explicitParentWorkspace && !explicitParentWorktree
      ? getEnvParentWorkspace()
      : undefined
  let cwdParentWorktree: string | undefined
  const needsCwdRepoInference = !flags.has('repo') && !hasWorkspaceProjectTarget(flags)
  if ((!explicitParentWorktree && !explicitParentWorkspace && !noParent) || needsCwdRepoInference) {
    try {
      // Why: agent shells can lose ORCA_TERMINAL_HANDLE while still running
      // inside an Orca worktree. Cwd keeps CLI-created children nestable and
      // lets create infer the repo for the common current-workspace case.
      cwdParentWorktree = await resolveCurrentWorktreeSelector(cwd, client)
    } catch (error) {
      const optionalRemoteCwd =
        !needsCwdRepoInference &&
        client.isRemote &&
        error instanceof RuntimeClientError &&
        error.code === 'invalid_argument'
      if (
        optionalRemoteCwd ||
        (error instanceof RuntimeClientError && error.code === 'selector_not_found')
      ) {
        cwdParentWorktree = undefined
      } else {
        throw error
      }
    }
  }
  const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue')
  const activate = flags.get('activate') === true || flags.get('run-hooks') === true
  const name = getRequiredStringFlag(flags, 'name')
  const reservation = getOptionalResourceReservation(flags, 'worktree')
  if (reservation) {
    await assertResourceReservationSupported(client)
  }
  return {
    ...(reservation ? { reservation } : {}),
    params: {
      repo: await getCreateRepoSelector(flags, cwdParentWorktree, client),
      name,
      displayName: name,
      displayNameKind: 'user',
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      linkedIssue: getOptionalNumberFlag(flags, 'issue'),
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      runHooks: flags.get('run-hooks') === true,
      activate,
      // Why: the CLI pairs as a runtime device but is not a viewer, so caller-scoped
      // delivery would make --activate a no-op against a remote runtime.
      ...(activate ? { navigation: 'all' as const } : {}),
      ...(setupDecision ? { setupDecision } : {}),
      parentWorktree: explicitParentWorktree,
      ...(explicitParentWorkspace ? { parentWorkspace: explicitParentWorkspace } : {}),
      ...(envParentWorkspace ? { envParentWorkspace } : {}),
      ...(cwdParentWorktree ? { cwdParentWorktree } : {}),
      noParent,
      callerTerminalHandle,
      // Why: marks the workspace as CLI-created so the sidebar can badge and
      // filter it. Sent on every `worktree create` — hand-typed or agent-run.
      cliProvenanceRequest: callerTerminalHandle ? { callerTerminalHandle } : {},
      ...(reservation ? { reservation } : {}),
      ...(startupAgent
        ? {
            startupAgent,
            startupPrompt: getPresentStringFlag(flags, 'prompt', { allowEmpty: true }) ?? ''
          }
        : {})
    }
  }
}
