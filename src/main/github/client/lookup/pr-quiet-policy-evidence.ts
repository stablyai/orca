import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { githubPRPolicyProjects } from '../../accounts/github-project-account'
import type { readTimedPROutcome } from './pr-last-outcome'

let revision = 0
let projects: ReturnType<typeof githubPRPolicyProjects> | undefined
let environment: Record<string, string | undefined> = {}
let cwd = ''

// Called once at a report boundary, never from a per-row policy decision.
export function refreshPRPolicyContext(): number {
  const next = githubPRPolicyProjects()
  const keys = Object.keys(process.env)
  if (
    next.source !== projects?.source ||
    next.selection !== projects?.selection ||
    cwd !== process.cwd() ||
    keys.length !== Object.keys(environment).length ||
    keys.some((key) => process.env[key] !== environment[key])
  ) {
    revision += 1
    projects = next
    environment = { ...process.env }
    cwd = process.cwd()
  }
  return revision
}

type Evidence = {
  revision: number
  current: () => boolean
  cached: () => ReturnType<typeof readTimedPROutcome>
}
const completed = new WeakMap<PRRefreshOutcome, Evidence>()
const projections = new Map<string, Evidence>()

function key(candidate: GitHubPRRefreshCandidate): string {
  return JSON.stringify([
    candidate.repoId,
    candidate.repoPath,
    candidate.connectionId ?? null,
    candidate.localGitOptions?.wslDistro ?? null,
    candidate.branch.replace(/^refs\/heads\//, ''),
    candidate.currentHeadOid ?? null,
    candidate.linkedPRNumber ?? null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRSource ?? null) : null
  ])
}

export function recordPRPolicyOutcome(outcome: PRRefreshOutcome, evidence: Evidence): void {
  completed.set(outcome, evidence)
}

export function projectPRPolicyOutcome(
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
): void {
  const evidence = completed.get(outcome)
  const identity = key(candidate)
  projections.delete(identity)
  if (evidence) {
    projections.set(identity, evidence)
  }
  while (projections.size > 256) {
    projections.delete(projections.keys().next().value!)
  }
}

export function quietPRIntervalForCandidate(candidate: GitHubPRRefreshCandidate): number | null {
  const evidence = projections.get(key(candidate))
  if (!evidence || evidence.revision !== revision || !evidence.current()) {
    return null
  }
  const cached = evidence.cached()
  if (
    cached?.outcome.kind !== 'found' ||
    cached.outcome.fetchedAt !== candidate.cachedFetchedAt ||
    candidate.cachedHasPR !== true ||
    candidate.cachedPRState !== cached.outcome.pr.state ||
    candidate.cachedChecksStatus !== cached.outcome.pr.checksStatus
  ) {
    return null
  }
  return cached.quietIntervalMs
}
