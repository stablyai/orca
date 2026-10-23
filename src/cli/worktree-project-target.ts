import { normalizeExecutionHostId, type ParsedExecutionHost } from '../shared/execution-host'
import {
  chooseReadyProjectHostSetup,
  isReadyProjectHostSetup
} from '../shared/project-host-setup-choice'
import type { ProjectHostSetup } from '../shared/project-types'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import { findProjectSetups, setupHostId } from './project-selector'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type ProjectCreateTarget = {
  repoSelector: string
  /** The selected setup's host; a repo id alone is ambiguous once it is set up on two hosts. */
  repoHostId: string
  setup: ProjectHostSetup
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export function hasWorkspaceProjectTarget(flags: Map<string, string | boolean>): boolean {
  return (
    flags.has('project') ||
    flags.has('host') ||
    flags.has('project-host-setup') ||
    flags.has('project-host-setup-base64')
  )
}

export function assertWorkspaceTargetFlagsCompatible(flags: Map<string, string | boolean>): void {
  const hasProjectTarget = hasWorkspaceProjectTarget(flags)
  if (flags.has('project-host-setup') && flags.has('project-host-setup-base64')) {
    throw new RuntimeClientError('invalid_argument', 'Choose one project host setup selector.')
  }
  if (flags.has('repo') && hasProjectTarget) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --repo or project target flags, not both.'
    )
  }
  if (
    flags.has('host') &&
    !flags.has('project') &&
    !flags.has('project-host-setup') &&
    !flags.has('project-host-setup-base64')
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host requires --project unless --project-host-setup is provided.'
    )
  }
}

// Why: the routed runtime can hold both an exact `runtime:<id>` row and a `local` row for the
// same project; the exact stamp is the one the caller named, so it wins the selection.
function selectSetupOnHost(
  candidates: readonly ProjectHostSetup[],
  host: ParsedExecutionHost | undefined,
  selectorLabel: string
): ProjectHostSetup | undefined {
  if (host) {
    const exact = candidates.filter(
      (candidate) => normalizeExecutionHostId(candidate.hostId) === host.id
    )
    return pickSingleSetup(
      exact.length > 0
        ? exact
        : candidates.filter((candidate) => hostFilterMatchesHostId(host, candidate.hostId)),
      selectorLabel,
      host
    )
  }
  // Why: one host is not a choice, so demanding --host for it was ceremony. Two are a choice, and
  // picking one would run the command on a machine the caller never named.
  const hostIds = new Set(candidates.map(setupHostId))
  if (hostIds.size <= 1) {
    return pickSingleSetup(candidates, selectorLabel)
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous ${terminalSafe(selectorLabel)}: it is set up on ${hostIds.size} hosts. Pass --host to choose one.`,
    {
      knownProjectHostSetups: candidates.map(summarizeSetup),
      nextSteps: [
        ...candidates.map(
          (candidate) =>
            `Use --host ${terminalSafe(setupHostId(candidate))} for ${terminalSafe(candidate.path)}.`
        ),
        'Run `orca host list` to see every machine you can target and the flag for each.'
      ]
    }
  )
}

function pickSingleSetup(
  candidates: readonly ProjectHostSetup[],
  selectorLabel: string,
  host?: ParsedExecutionHost
): ProjectHostSetup | undefined {
  const choice = chooseReadyProjectHostSetup(candidates)
  if (choice.status !== 'ambiguous') {
    return choice.status === 'single' ? choice.setup : undefined
  }
  const listed = choice.candidates
    .map((candidate) => {
      const selector = /^[A-Za-z0-9._:-]+$/.test(candidate.id)
        ? `--project-host-setup=${candidate.id}`
        : `--project-host-setup-base64=${Buffer.from(candidate.id).toString('base64url')}`
      return `  ${selector}  ${terminalSafe(candidate.path)}`
    })
    .join('\n')
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous ${terminalSafe(selectorLabel)}: ${choice.candidates.length} ready setups${host ? ` on ${terminalSafe(host.id)}` : ''}; pass a --project-host-setup selector shown below to choose one:\n${listed}`,
    { knownProjectHostSetups: choice.candidates.map(summarizeSetup) }
  )
}

function summarizeSetup(setup: ProjectHostSetup): {
  id: string
  hostId: string
  path: string
} {
  return { id: setup.id, hostId: setupHostId(setup), path: setup.path }
}

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const rawSetupId = getPresentStringFlag(flags, 'project-host-setup')
  const encodedSetupId = getPresentStringFlag(flags, 'project-host-setup-base64')
  if (rawSetupId && encodedSetupId) {
    throw new RuntimeClientError('invalid_argument', 'Choose one project host setup selector.')
  }
  const decodedSetupId = encodedSetupId
    ? Buffer.from(encodedSetupId, 'base64url').toString('utf8')
    : undefined
  if (
    encodedSetupId &&
    (!decodedSetupId || Buffer.from(decodedSetupId).toString('base64url') !== encodedSetupId)
  ) {
    throw new RuntimeClientError('invalid_argument', 'Invalid --project-host-setup-base64 value.')
  }
  const projectHostSetupId = rawSetupId ?? decodedSetupId
  const projectId = getPresentStringFlag(flags, 'project')
  const host = await resolveHostFlagTarget(flags, client)
  if (!projectHostSetupId && !projectId && !host) {
    return undefined
  }
  let result: Awaited<ReturnType<typeof client.call<{ setups: ProjectHostSetup[] }>>>
  try {
    result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  } catch (error) {
    // Why: --host runtime:<id> routes here, so an older server is reachable without the caller
    // meaning to; name the version gap rather than surfacing a raw method_not_found.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support project host setup yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
  // Match against every setup so an exact id with no ready setup never falls through to a name.
  const candidates =
    projectId === undefined || projectHostSetupId
      ? []
      : (await findProjectSetups(client, result.result.setups, projectId)).filter(
          isReadyProjectHostSetup
        )
  // Why --host applies to both: setup ids are per host, so the same id can name two setups.
  const setup = projectHostSetupId
    ? selectSetupOnHost(
        findReadySetupsById(result.result.setups, projectHostSetupId),
        host,
        `--project-host-setup ${projectHostSetupId}`
      )
    : selectSetupOnHost(candidates, host, `--project ${projectId}`)
  if (!setup) {
    if (projectHostSetupId) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Project host setup is not ready or was not found: ${terminalSafe(projectHostSetupId)}${host ? ` on ${terminalSafe(host.id)}` : ''}`
      )
    }
    // Why: blaming the host when no project matched sent callers to debug the wrong flag.
    if (candidates.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `No ready setup found for --project ${terminalSafe(projectId ?? '')} on any host.`,
        {
          nextSteps: [
            'Run `orca project list` for project ids and names, and `orca project setups` for where each is set up.'
          ]
        }
      )
    }
    throw new RuntimeClientError(
      'invalid_argument',
      `Project is not set up on the selected host: ${terminalSafe(projectId ?? '')}${host ? ` on ${terminalSafe(host.id)}` : ''}`,
      // Why: when the project is set up somewhere just not here, the recoverable answer is which
      // hosts do have it — otherwise the caller has to go re-derive the listing by hand.
      {
        knownProjectHostSetups: candidates.map(summarizeSetup),
        nextSteps: candidates.map(
          (candidate) =>
            `Use --host ${terminalSafe(setupHostId(candidate))} for ${terminalSafe(candidate.path)}.`
        )
      }
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    repoHostId: setupHostId(setup),
    setup
  }
}

function findReadySetupsById(
  setups: readonly ProjectHostSetup[],
  requestedId: string
): ProjectHostSetup[] {
  return setups.filter(
    (candidate) => candidate.id === requestedId && isReadyProjectHostSetup(candidate)
  )
}

// Escape backslashes first so literal escape text and control characters stay distinct.
function terminalSafe(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(
    // oxlint-disable-next-line no-control-regex -- persisted metadata must not control terminal output
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

// Why the worktree id, not the selector: a host-scoped `identity:` selector carries no repo id.
function getRepoSelectorFromWorktreeId(worktreeId: string | undefined): string | undefined {
  const separatorIndex = worktreeId?.indexOf('::') ?? -1
  if (!worktreeId || separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

/**
 * The repo a create names, as RPC params: spread it whole into every call that looks the repo up,
 * so the host a project target picked is never dropped. `--repo` stays selector-only.
 */
export type CliRepoTarget = { repo: string; repoHostId?: string }

export async function getCreateRepoTarget(
  flags: Map<string, string | boolean>,
  cwdParentWorktree: { worktreeId: string } | undefined,
  client: RuntimeClient
): Promise<CliRepoTarget> {
  const projectTarget = await resolveProjectCreateTarget(flags, client)
  if (projectTarget) {
    return { repo: projectTarget.repoSelector, repoHostId: projectTarget.repoHostId }
  }
  const explicitRepo = getPresentStringFlag(flags, 'repo')
  if (explicitRepo) {
    return { repo: explicitRepo }
  }
  const inferredRepo = getRepoSelectorFromWorktreeId(cwdParentWorktree?.worktreeId)
  if (inferredRepo) {
    return { repo: inferredRepo }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.'
  )
}
