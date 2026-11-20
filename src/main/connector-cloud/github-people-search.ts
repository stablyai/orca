// "Who can ask" › Add on GitHub: the people the owner works with, found through the host's own `gh`.
// The cloud only resolves one exact username, so typing a teammate's first name found a stranger.
//
// Budget, per host process: one gh call per search and at most one alive; a newer search aborts the
// one in flight (from any client: they share the host's gh). One deadline, LOCAL_DEADLINE_MS, covers
// the whole call including the runner's binary fallback, and the call is never retried. Nothing is
// cached, so every result comes with the account it was read as.
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import {
  BOT_GITHUB_OFF,
  GITHUB_LOGIN_PATTERN,
  type BotGitHubPeople,
  type ConnectorGitHubUsersResponse
} from '../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import type { GitHubPeopleScope } from '../../shared/bots/github-people-scope'
import {
  MAX_GITHUB_PEOPLE,
  peopleQuery,
  rankGitHubPeople,
  readPeople,
  targetOf,
  type GitHubPerson
} from './github-people-query'

export {
  MAX_GITHUB_PEOPLE,
  peopleQuery,
  rankGitHubPeople,
  type GitHubPerson
} from './github-people-query'

/** The exact-username answer waits at most this long for the repositories' answer. */
export const LOCAL_DEADLINE_MS = 4_000

export type GhRun = (args: string[], signal: AbortSignal) => Promise<string>

// No retries (`idempotent: false`): a retry's backoff would outlast the deadline. The signal kills
// the child, and any fallback child, when the deadline passes or a newer search starts.
const ghRun: GhRun = async (args, signal) => {
  try {
    const { stdout } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      host: 'github.com',
      idempotent: false,
      timeout: LOCAL_DEADLINE_MS,
      signal
    })
    return stdout
  } catch (error) {
    // A GraphQL error on one source exits non-zero but still prints the others' data.
    return extractExecError(error).stdout
  }
}

export type LocalSearch = {
  people: GitHubPerson[]
  /** Some of the scope or its matches was not searched or not returned. */
  limited: boolean
  /** Typing more would bring in matches left out; false when the cut doesn't depend on it. */
  narrowable: boolean
  /** The account gh read every source as, from the same call; null when it did not say. */
  viewer: string | null
}

export class GitHubPeopleSearch {
  private inFlight: AbortController | null = null

  constructor(
    private readonly run: GhRun = ghRun,
    private readonly deadlineMs: number = LOCAL_DEADLINE_MS
  ) {}

  /** The people of `scope` matching `query`, best first; null when no source could be read (gh
   *  missing, signed out, offline, past the deadline) or a newer search replaced this one. */
  async search(query: string, scope: GitHubPeopleScope): Promise<LocalSearch | null> {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    const deadline = setTimeout(() => controller.abort(), this.deadlineMs)
    try {
      const { target, dropped } = targetOf(scope)
      const built = peopleQuery(query.trim(), target)
      const args = ['api', 'graphql', '-f', `query=${built.document}`]
      for (const [key, value] of Object.entries(built.vars)) {
        args.push('-f', `${key}=${value}`)
      }
      const stdout = await this.run(args, controller.signal)
      const read = controller.signal.aborted ? null : readPeople(stdout, target)
      // The viewer alone is not a search: success needs at least one source read.
      if (!read || read.sourcesRead === 0) {
        return null
      }
      const ranked = rankGitHubPeople(read.people, query)
      const overflow = ranked.length > MAX_GITHUB_PEOPLE
      return {
        people: ranked.slice(0, MAX_GITHUB_PEOPLE),
        limited:
          scope.more || dropped || read.lossy || read.scopeCut || read.matchesCapped || overflow,
        narrowable: read.matchesCapped || overflow,
        viewer: read.viewer
      }
    } finally {
      clearTimeout(deadline)
      if (this.inFlight === controller) {
        this.inFlight = null
      }
    }
  }
}

type CloudUsers = (query: string) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>
type Coverage = NonNullable<BotGitHubPeople['coverage']>

/** The picker's answer: people found in the scope, then anyone on GitHub with exactly that
 *  username (up to MAX_GITHUB_PEOPLE + 1), each with where they were found and what was searched. */
export async function findGitHubPeople(
  cloudUsers: CloudUsers,
  query: string,
  scope: GitHubPeopleScope | undefined,
  local: Pick<GitHubPeopleSearch, 'search'>
): Promise<BotSlackResult<BotGitHubPeople>> {
  const login = query.trim()
  const scoped = scope !== undefined && (scope.repositories.length > 0 || scope.owners.length > 0)
  const [found, exact] = await Promise.all([
    scoped ? local.search(login, scope) : Promise.resolve(null),
    // The cloud answers one exact username; anything else is not worth a round trip.
    GITHUB_LOGIN_PATTERN.test(login) ? cloudUsers(login) : Promise.resolve(null)
  ])
  // GitHub off for this account, as the cloud just said, is definitive.
  if (exact && !exact.ok && exact.error === BOT_GITHUB_OFF) {
    return exact
  }
  // No source answered and the exact lookup failed: the error, so the picker offers a retry.
  if (exact && !exact.ok && found === null) {
    return exact
  }
  const searched: Coverage['local'] =
    scope === undefined
      ? 'skipped'
      : !scoped
        ? 'none'
        : found === null
          ? 'unavailable'
          : found.limited
            ? 'limited'
            : 'full'
  const people = found?.people ?? []
  const known = new Set(people.map((person) => person.id))
  const members: BotGitHubPeople['members'] = people.map((person) => ({
    id: person.id,
    name: person.login,
    found: 'scope' as const,
    ...(person.name && person.name !== person.login ? { handle: person.name } : {})
  }))
  for (const member of exact?.ok ? exact.value.members : []) {
    if (!known.has(member.id)) {
      // Only a complete search of the scope shows the scope's search didn't find them.
      members.push({
        id: member.id,
        name: member.name,
        found: searched === 'full' ? 'outside' : 'exact'
      })
    }
  }
  return {
    ok: true,
    value: {
      members,
      complete: searched === 'full' && exact?.ok !== false,
      coverage: {
        local: searched,
        exact: exact === null ? 'skipped' : exact.ok ? 'searched' : 'failed',
        ...(found?.narrowable ? { narrowable: true } : {}),
        ...(found?.viewer ? { searchedAs: found.viewer } : {})
      }
    }
  }
}

let shared: GitHubPeopleSearch | null = null
/** The host's one search slot. */
export function gitHubPeopleSearch(): GitHubPeopleSearch {
  shared ??= new GitHubPeopleSearch()
  return shared
}
