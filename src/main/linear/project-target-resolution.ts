import type { LinearProjectResolvedBy } from '../../shared/linear/project-agent-access'
import { isLinearUuid } from '../../shared/linear/uuid'
import { linearError, type LinearAgentAccessError } from './issue-context-errors'
import {
  findLinearProjectsByExactTarget,
  lookupLinearProjectById,
  type LinearProjectTargetCandidate
} from './project-target-lookup'
import { parseLinearProjectUrl } from './project-url-target'
import {
  assertLinearUrlWorkspaceMatches,
  resolveLinearWorkspaceByUrlKey,
  selectLinearProjectWorkspaces
} from './project-workspace-scope'

export type LinearResolvedProject = {
  id: string
  name: string
  slugId: string
  url: string
  workspaceId: string
  workspaceName: string
  resolvedBy: LinearProjectResolvedBy
}

/** Exact matches for one workspace, before any uniqueness decision. */
export type LinearProjectTargetCandidates = {
  candidates: LinearProjectTargetCandidate[]
  slugMatchIds: Set<string>
  ambiguous: boolean
}

const RETRY_BY_ID_STEP = 'Run `orca linear project list --query <name> --json` and retry by id.'
const READ_ACTION = 'a project read'

export async function resolveLinearProjectTarget(
  input: string,
  workspaceId: string | undefined,
  options: { signal?: AbortSignal } = {}
): Promise<LinearResolvedProject> {
  const trimmed = input.trim()
  if (!trimmed) {
    throw linearError(
      'linear_invalid_project',
      'Pass a non-empty Linear project id, slug, name, or URL.',
      { nextSteps: [RETRY_BY_ID_STEP] }
    )
  }

  const urlTarget = parseLinearProjectUrl(trimmed)
  if (urlTarget) {
    const workspace = resolveLinearWorkspaceByUrlKey(urlTarget.workspaceKey)
    assertLinearUrlWorkspaceMatches(workspace, workspaceId)
    const entries = selectLinearProjectWorkspaces(workspace.id, READ_ACTION)
    const matches = await findLinearProjectsByExactTarget(
      entries[0],
      urlTarget.slug,
      options.signal
    )
    if (matches.slugHasMore || matches.bySlug.length > 1) {
      throw ambiguousLinearProject(urlTarget.slug, matches.bySlug)
    }
    if (matches.bySlug.length === 0) {
      throw missingLinearProject(trimmed, [])
    }
    return resolvedProject(matches.bySlug[0], 'url')
  }

  const entries = selectLinearProjectWorkspaces(workspaceId, READ_ACTION)

  if (isLinearUuid(trimmed)) {
    // Why: a UUID miss is a miss — falling back to name lookup could silently target another project.
    const found = await Promise.all(
      entries.map((entry) => lookupLinearProjectById(entry, trimmed, options.signal))
    )
    const hits = found.filter(
      (project): project is LinearProjectTargetCandidate => project !== null
    )
    if (hits.length > 1) {
      throw ambiguousLinearProject(trimmed, hits)
    }
    if (hits.length === 0) {
      throw missingLinearProject(trimmed, [])
    }
    return resolvedProject(hits[0], 'uuid')
  }

  // Why: Promise.all rejects on the first workspace failure — a partial fan-out cannot prove uniqueness.
  const perWorkspace = await Promise.all(
    entries.map((entry) => findExactTargetCandidates(entry, trimmed, options.signal))
  )
  const merged = mergeTargetCandidates(perWorkspace)
  if (merged.ambiguous || merged.candidates.length > 1) {
    throw ambiguousLinearProject(trimmed, merged.candidates)
  }
  if (merged.candidates.length === 0) {
    throw missingLinearProject(trimmed, [])
  }
  const match = merged.candidates[0]
  return resolvedProject(match, merged.slugMatchIds.has(match.id) ? 'slug' : 'name')
}

/**
 * Workspace-scoped exact lookup without a uniqueness verdict, so callers that
 * disambiguate on their own (create's target-team check) share this grammar.
 */
export async function findLinearProjectTargetCandidates(
  input: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectTargetCandidates> {
  const trimmed = input.trim()
  const entries = selectLinearProjectWorkspaces(workspaceId, READ_ACTION)
  if (isLinearUuid(trimmed)) {
    const project = await lookupLinearProjectById(entries[0], trimmed, options.signal)
    return {
      candidates: project ? [project] : [],
      slugMatchIds: new Set<string>(),
      ambiguous: false
    }
  }
  return mergeTargetCandidates([
    await findExactTargetCandidates(entries[0], trimmed, options.signal)
  ])
}

async function findExactTargetCandidates(
  entry: Parameters<typeof findLinearProjectsByExactTarget>[0],
  term: string,
  signal: AbortSignal | undefined
): Promise<LinearProjectTargetCandidates> {
  const matches = await findLinearProjectsByExactTarget(entry, term, signal)
  const candidates = new Map<string, LinearProjectTargetCandidate>()
  const slugMatchIds = new Set<string>()
  for (const candidate of matches.bySlug) {
    candidates.set(candidate.id, candidate)
    slugMatchIds.add(candidate.id)
  }
  for (const candidate of matches.byName) {
    if (!candidates.has(candidate.id)) {
      candidates.set(candidate.id, candidate)
    }
  }
  return {
    candidates: [...candidates.values()],
    slugMatchIds,
    ambiguous: matches.slugHasMore || matches.nameHasMore
  }
}

function mergeTargetCandidates(
  results: LinearProjectTargetCandidates[]
): LinearProjectTargetCandidates {
  const candidates = new Map<string, LinearProjectTargetCandidate>()
  const slugMatchIds = new Set<string>()
  let ambiguous = false
  for (const result of results) {
    ambiguous ||= result.ambiguous
    for (const candidate of result.candidates) {
      if (!candidates.has(candidate.id)) {
        candidates.set(candidate.id, candidate)
      }
    }
    for (const id of result.slugMatchIds) {
      slugMatchIds.add(id)
    }
  }
  return { candidates: [...candidates.values()], slugMatchIds, ambiguous }
}

function ambiguousLinearProject(
  input: string,
  candidates: LinearProjectTargetCandidate[]
): LinearAgentAccessError {
  return linearError(
    'linear_invalid_project',
    `Multiple Linear projects exactly matched "${input}".`,
    {
      projects: candidates.map(projectCandidateData),
      nextSteps: ['Retry with --workspace <id> and the project id.', RETRY_BY_ID_STEP]
    }
  )
}

function missingLinearProject(
  input: string,
  candidates: LinearProjectTargetCandidate[]
): LinearAgentAccessError {
  return linearError('linear_invalid_project', `No Linear project exactly matched "${input}".`, {
    projects: candidates.map(projectCandidateData),
    nextSteps: [RETRY_BY_ID_STEP]
  })
}

function projectCandidateData(candidate: LinearProjectTargetCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    name: candidate.name,
    slugId: candidate.slugId,
    url: candidate.url,
    teams: candidate.teams,
    workspace: { id: candidate.workspaceId, name: candidate.workspaceName }
  }
}

function resolvedProject(
  candidate: LinearProjectTargetCandidate,
  resolvedBy: LinearProjectResolvedBy
): LinearResolvedProject {
  return {
    id: candidate.id,
    name: candidate.name,
    slugId: candidate.slugId,
    url: candidate.url,
    workspaceId: candidate.workspaceId,
    workspaceName: candidate.workspaceName,
    resolvedBy
  }
}
