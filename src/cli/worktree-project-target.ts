import { normalizeExecutionHostId, type ParsedExecutionHost } from '../shared/execution-host'
import {
  chooseReadyProjectHostSetup,
  isReadyProjectHostSetup
} from '../shared/project-host-setup-choice'
import type { ProjectHostSetup } from '../shared/project-types'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type ProjectCreateTarget = {
  repoSelector: string
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
  return flags.has('project') || flags.has('host') || flags.has('project-host-setup')
}

export function assertWorkspaceTargetFlagsCompatible(flags: Map<string, string | boolean>): void {
  const hasProjectTarget = hasWorkspaceProjectTarget(flags)
  if (flags.has('repo') && hasProjectTarget) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --repo or project target flags, not both.'
    )
  }
  if (flags.has('host') && !flags.has('project') && !flags.has('project-host-setup')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host requires --project unless --project-host-setup is provided.'
    )
  }
}

export async function resolveProjectCreateRepoSelector(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  return (await resolveProjectCreateTarget(flags, client))?.repoSelector
}

// Why: the routed runtime can hold both an exact `runtime:<id>` row and a `local` row for the
// same project; the exact stamp is the one the caller named, so it wins the selection.
function findReadySetupOnHost(
  setups: readonly ProjectHostSetup[],
  projectId: string | undefined,
  host: ParsedExecutionHost | undefined
): ProjectHostSetup | undefined {
  const candidates = setups.filter((candidate) => candidate.projectId === projectId)
  if (!host) {
    return pickSingleSetup(candidates, projectId, undefined)
  }
  const exact = candidates.filter(
    (candidate) => normalizeExecutionHostId(candidate.hostId) === host.id
  )
  if (exact.length > 0) {
    return pickSingleSetup(exact, projectId, host)
  }
  // Why: `local` means "the box that answered", which is the same machine as `runtime:<id>` only
  // when the command already runs there, so the broader filter is a last resort, not a peer.
  return pickSingleSetup(
    candidates.filter((candidate) => hostFilterMatchesHostId(host, candidate.hostId)),
    projectId,
    host
  )
}

function pickSingleSetup(
  matches: readonly ProjectHostSetup[],
  projectId: string | undefined,
  host: ParsedExecutionHost | undefined
): ProjectHostSetup | undefined {
  const choice = chooseReadyProjectHostSetup(matches)
  if (choice.status !== 'ambiguous') {
    return choice.status === 'single' ? choice.setup : undefined
  }
  // Why: list the id alongside the path — the remedy we name is `--project-host-setup <id>`, so an
  // error that prints only paths asks for something it never showed.
  const listed = choice.candidates
    .map((candidate) => `  ${terminalSafe(candidate.id)}  ${terminalSafe(candidate.path)}`)
    .join('\n')
  const where = host ? ` on ${host.id}` : ''
  throw new RuntimeClientError(
    'invalid_argument',
    `"${projectId}" has ${choice.candidates.length} ready setups${where}; pass --project-host-setup <id> to choose one:\n${listed}`
  )
}

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const projectHostSetupId = getPresentStringFlag(flags, 'project-host-setup')
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
  const ready = result.result.setups.filter(isReadyProjectHostSetup)
  const setup = projectHostSetupId
    ? findReadySetupById(ready, projectHostSetupId)
    : findReadySetupOnHost(ready, projectId, host)
  if (!setup) {
    throw new RuntimeClientError(
      'invalid_argument',
      projectHostSetupId
        ? `Project host setup is not ready or was not found: ${projectHostSetupId}`
        : `Project is not set up on the selected host: ${projectId}${host ? ` on ${host.id}` : ''}`
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    setup
  }
}

function findReadySetupById(
  setups: readonly ProjectHostSetup[],
  requestedId: string
): ProjectHostSetup | undefined {
  // Raw ids take precedence for backwards compatibility; the escaped form is only a fallback for
  // ids copied from the ambiguity diagnostic.
  return (
    setups.find((candidate) => candidate.id === requestedId) ??
    setups.find((candidate) => terminalSafe(candidate.id) === requestedId)
  )
}

// Why: setup ids and paths are persisted metadata printed straight to a terminal, so anything that
// can move the cursor, change colour, reorder text, or hide characters could forge a setup line.
// Backslash is escaped FIRST — otherwise an id containing the literal text "\u000a" renders
// identically to one containing a real newline, and the printed id could not be copied back into
// --project-host-setup unambiguously.
function terminalSafe(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g,
    (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`
  )
}
