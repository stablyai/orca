// "Who can ask" › Add on GitHub: the people the owner works with, found through the host's own `gh`.
// The cloud only resolves one exact username, so typing a teammate's first name found a stranger.
//
// Budgets, per host process: at most one gh child at a time, one search queued behind it (a newer
// one replaces it), each child killed at LOCAL_DEADLINE_MS and never retried; an account's roster
// (an organization's members, a person's own repositories) is read at most once per ROSTER_TTL_MS.
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import {
  BOT_GITHUB_OFF,
  GITHUB_LOGIN_PATTERN,
  type BotGitHubPeople,
  type ConnectorGitHubUsersResponse
} from '../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import {
  GITHUB_PEOPLE_MAX_OWNERS,
  GITHUB_PEOPLE_MAX_REPOSITORIES,
  type GitHubPeopleScope
} from '../../shared/bots/github-people-scope'
import {
  RepositoryAnswer,
  RosterAnswer,
  RosterViewer,
  finish,
  graphqlArgs,
  json,
  peopleOf,
  repositoryOf,
  repositoryQuery,
  rosterFrom,
  rosterQuery,
  type GitHubPerson,
  type LocalSearch,
  type Roster
} from './github-people-query'

export {
  MAX_GITHUB_PEOPLE,
  rankGitHubPeople,
  repositoryQuery,
  rosterQuery,
  type GitHubPerson,
  type LocalSearch
} from './github-people-query'

/** A keystroke's search is interactive: past this the exact-username answer goes out alone. */
export const LOCAL_DEADLINE_MS = 5_000
export const ROSTER_TTL_MS = 5 * 60_000

export type GhRun = (args: string[]) => Promise<string>

// No retries (`idempotent: false`): a retry's backoff would hold the exact answer past the deadline.
const ghRun: GhRun = async (args) => {
  try {
    const { stdout } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      host: 'github.com',
      idempotent: false,
      timeout: LOCAL_DEADLINE_MS
    })
    return stdout
  } catch (error) {
    // A GraphQL error on one alias exits non-zero but still prints the other aliases' data.
    return extractExecError(error).stdout
  }
}

export class GitHubPeopleSearch {
  private rosters = new Map<string, { roster: Roster; at: number }>()
  /** Who the last roster read ran as: an organization-only search asks gh nothing else. */
  private rosterViewer: string | null = null
  private running = false
  private queued: { start: () => void; supersede: () => void } | null = null

  constructor(
    private readonly run: GhRun = ghRun,
    private readonly now: () => number = Date.now
  ) {}

  /** Runs `task` once no other search is running; a newer call replaces a waiting one, which
   *  resolves null without starting anything. */
  private exclusive<T>(task: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const start = (): void => {
        this.running = true
        void task()
          .then(resolve, () => resolve(null))
          .finally(() => {
            this.running = false
            const next = this.queued
            this.queued = null
            next?.start()
          })
      }
      if (!this.running) {
        start()
        return
      }
      this.queued?.supersede()
      this.queued = { start, supersede: () => resolve(null) }
    })
  }

  private async rostersOf(owners: string[]): Promise<Roster[]> {
    const rosters: Roster[] = []
    const missing: string[] = []
    for (const owner of owners) {
      const cached = this.rosters.get(owner.toLowerCase())
      if (cached && this.now() - cached.at < ROSTER_TTL_MS) {
        rosters.push(cached.roster)
      } else {
        missing.push(owner)
      }
    }
    if (missing.length === 0) {
      return rosters
    }
    const built = rosterQuery(missing)
    const answer = json(await this.run(graphqlArgs(built.document, built.vars)))
    const parsed = RosterAnswer.safeParse(answer)
    const viewer = RosterViewer.safeParse(answer)
    this.rosterViewer = viewer.success ? viewer.data.data.viewer.login : null
    missing.forEach((owner, index) => {
      const roster = rosterFrom(parsed.success ? parsed.data.data[`a${index}`] : undefined)
      rosters.push(roster)
      // An unreadable roster (gh failed) is asked again next time rather than remembered.
      if (roster.kind !== 'unreadable') {
        this.rosters.set(owner.toLowerCase(), { roster, at: this.now() })
      }
    })
    return rosters
  }

  /** The people of `scope` matching `query`, best first, with how much of the scope was searched
   *  and as whom; null when gh gave nothing usable (missing, signed out, offline, too slow) or a
   *  newer search took this one's place. */
  search(query: string, scope: GitHubPeopleScope): Promise<LocalSearch | null> {
    return this.exclusive(async () => {
      const owners = scope.owners
        .filter((login) => GITHUB_LOGIN_PATTERN.test(login))
        .slice(0, GITHUB_PEOPLE_MAX_OWNERS)
      const rosters = owners.length > 0 ? await this.rostersOf(owners) : []
      let limited = scope.more || owners.length < scope.owners.length
      const people: GitHubPerson[] = []
      const names = [...scope.repositories]
      for (const roster of rosters) {
        if (roster.kind === 'organization') {
          people.push(...roster.people)
        } else if (roster.kind === 'user') {
          names.push(...roster.repositories)
        }
        limited ||= roster.kind === 'unreadable' || !roster.complete
      }
      const unique = new Map<string, [string, string]>()
      for (const name of names) {
        const repo = repositoryOf(name)
        limited ||= repo === null
        if (repo) {
          unique.set(name.toLowerCase(), repo)
        }
      }
      const searched = [...unique.values()].slice(0, GITHUB_PEOPLE_MAX_REPOSITORIES)
      limited ||= unique.size > searched.length
      const answer =
        searched.length > 0 || people.length === 0
          ? await this.searchRepositories(query.trim(), searched)
          : null
      if (answer) {
        return finish(
          [...people, ...answer.people],
          query,
          limited || answer.limited,
          answer.viewer
        )
      }
      // The repositories gave nothing, but an organization roster read earlier still answers.
      return people.length > 0
        ? finish(
            people,
            query,
            limited || searched.length > 0,
            searched.length > 0 ? null : this.rosterViewer
          )
        : null
    })
  }

  private async searchRepositories(
    query: string,
    repositories: [string, string][]
  ): Promise<LocalSearch | null> {
    const built = repositoryQuery(query, repositories)
    const parsed = RepositoryAnswer.safeParse(
      json(await this.run(graphqlArgs(built.document, built.vars)))
    )
    const data = parsed.success ? parsed.data.data : null
    if (!data) {
      return null
    }
    let limited = false
    const people: GitHubPerson[] = []
    repositories.forEach((_repo, index) => {
      const users = data[`r${index}`]?.assignableUsers
      if (!users) {
        limited = true
        return
      }
      people.push(...peopleOf(users.nodes))
      limited ||= users.totalCount > users.nodes.length
    })
    return { people, limited, viewer: data.viewer?.login ?? null }
  }
}

type CloudUsers = (query: string) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>

/** The picker's answer: people the owner works with, then anyone on GitHub with exactly that
 *  username, each with where they were found and how much was searched. */
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
  // GitHub off for this account is definitive: nothing found here would mean anything.
  if (exact && !exact.ok && (exact.error === BOT_GITHUB_OFF || found === null)) {
    return exact
  }
  const searched: NonNullable<BotGitHubPeople['coverage']>['local'] = !scoped
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
      // Only a complete search of the scope shows someone is outside it.
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
        ...(found?.viewer ? { searchedAs: found.viewer } : {})
      }
    }
  }
}

let shared: GitHubPeopleSearch | null = null
/** The host's one search queue and roster cache. */
export function gitHubPeopleSearch(): GitHubPeopleSearch {
  shared ??= new GitHubPeopleSearch()
  return shared
}
