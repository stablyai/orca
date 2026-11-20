// Who can ask › Add on GitHub: the GraphQL the host's gh runs, how its answers are read, and how
// the people found are ranked. github-people-search.ts runs it within its budgets.
import * as z from 'zod'
import { GITHUB_ID_PATTERN, GITHUB_LOGIN_PATTERN } from '../../shared/connector-bot-github-contract'
import { GITHUB_PEOPLE_MAX_REPOSITORIES } from '../../shared/bots/github-people-scope'

export type GitHubPerson = { id: string; login: string; name: string | null }

const PER_REPOSITORY = 30
const ORGANIZATION_MEMBERS = 100
export const MAX_GITHUB_PEOPLE = 30

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PERSON_FIELDS = 'databaseId login name'

export function graphqlArgs(document: string, vars: Record<string, string>): string[] {
  const args = ['api', 'graphql', '-f', `query=${document}`]
  for (const [key, value] of Object.entries(vars)) {
    args.push('-f', `${key}=${value}`)
  }
  return args
}

export function repositoryOf(fullName: string): [string, string] | null {
  const [owner, name, extra] = fullName.split('/')
  return extra === undefined &&
    owner &&
    name &&
    GITHUB_LOGIN_PATTERN.test(owner) &&
    REPOSITORY_NAME.test(name)
    ? [owner, name]
    : null
}

// Read leniently: one odd node or one unreadable alias must not lose everyone else.
const RawPerson = z.object({
  databaseId: z.number().int(),
  login: z.string().regex(GITHUB_LOGIN_PATTERN),
  name: z.string().nullable().optional()
})
const Connection = z.object({ totalCount: z.number().int(), nodes: z.array(z.unknown()) })
export function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

export function peopleOf(nodes: unknown[]): GitHubPerson[] {
  const people: GitHubPerson[] = []
  for (const node of nodes) {
    const person = RawPerson.safeParse(node)
    const id = person.success ? String(person.data.databaseId) : ''
    if (person.success && GITHUB_ID_PATTERN.test(id)) {
      people.push({ id, login: person.data.login, name: person.data.name?.trim() || null })
    }
  }
  return people
}

// Rosters: what a whole-account install contributes, read at most once per ROSTER_TTL_MS.
export type Roster =
  | { kind: 'organization'; people: GitHubPerson[]; complete: boolean }
  | { kind: 'user'; repositories: string[]; complete: boolean }
  | { kind: 'unreadable' }

export const RosterAnswer = z.object({
  data: z.record(
    z.string(),
    // `viewer` rides along as the one non-roster field; it never parses as a roster.
    z
      .object({
        membersWithRole: Connection.optional(),
        repositories: z
          .object({
            totalCount: z.number().int(),
            nodes: z.array(z.object({ nameWithOwner: z.string() }).nullable())
          })
          .optional()
      })
      .nullable()
      .catch(null)
  )
})

export function rosterQuery(owners: string[]): { document: string; vars: Record<string, string> } {
  const params: string[] = []
  const fields: string[] = []
  const vars: Record<string, string> = {}
  owners.forEach((login, index) => {
    params.push(`$a${index}: String!`)
    vars[`a${index}`] = login
    fields.push(
      `a${index}: repositoryOwner(login: $a${index}) { ` +
        `... on Organization { membersWithRole(first: ${ORGANIZATION_MEMBERS}) { totalCount nodes { ${PERSON_FIELDS} } } } ` +
        `... on User { repositories(first: ${GITHUB_PEOPLE_MAX_REPOSITORIES}, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) { totalCount nodes { nameWithOwner } } } }`
    )
  })
  return { document: `query(${params.join(', ')}) { viewer { login } ${fields.join(' ')} }`, vars }
}

export const RosterViewer = z.object({
  data: z.object({ viewer: z.object({ login: z.string() }) })
})

export function rosterFrom(
  entry: z.infer<typeof RosterAnswer>['data'][string] | undefined
): Roster {
  if (entry?.membersWithRole) {
    const members = entry.membersWithRole
    return {
      kind: 'organization',
      people: peopleOf(members.nodes),
      complete: members.totalCount <= members.nodes.length
    }
  }
  if (entry?.repositories) {
    const repositories = entry.repositories
    return {
      kind: 'user',
      repositories: repositories.nodes.flatMap((node) => (node ? [node.nameWithOwner] : [])),
      complete: repositories.totalCount <= repositories.nodes.length
    }
  }
  return { kind: 'unreadable' }
}

export const RepositoryAnswer = z.object({
  data: z
    .object({ viewer: z.object({ login: z.string() }).nullable().catch(null).optional() })
    .catchall(z.object({ assignableUsers: Connection }).nullable().catch(null))
    .nullable()
    .optional()
})

/** One GraphQL call per keystroke; names travel as variables, never spliced into the text. The
 *  viewer is read in the same call, so it is the account the search really ran as. */
export function repositoryQuery(
  query: string,
  repositories: [string, string][]
): { document: string; vars: Record<string, string> } {
  // GraphQL rejects a declared variable no field uses, so $q comes only with a repository.
  const params: string[] = repositories.length > 0 ? ['$q: String!'] : []
  const fields: string[] = ['viewer { login }']
  const vars: Record<string, string> = repositories.length > 0 ? { q: query } : {}
  repositories.forEach(([owner, name], index) => {
    params.push(`$ro${index}: String!`, `$rn${index}: String!`)
    vars[`ro${index}`] = owner
    vars[`rn${index}`] = name
    // Filters on login and name server-side, so a first name finds the teammate.
    fields.push(
      `r${index}: repository(owner: $ro${index}, name: $rn${index}) { assignableUsers(query: $q, first: ${PER_REPOSITORY}) { totalCount nodes { ${PERSON_FIELDS} } } }`
    )
  })
  const head = params.length > 0 ? `query(${params.join(', ')})` : 'query'
  return { document: `${head} { ${fields.join(' ')} }`, vars }
}

export type LocalSearch = {
  people: GitHubPerson[]
  /** Some of the scope was not searched (caps, an unreadable repository, more results). */
  limited: boolean
  /** The GitHub account gh searched as; null when it could not say. */
  viewer: string | null
}

export function finish(
  people: GitHubPerson[],
  query: string,
  limited: boolean,
  viewer: string | null
): LocalSearch {
  const ranked = rankGitHubPeople(people, query)
  return {
    people: ranked.slice(0, MAX_GITHUB_PEOPLE),
    limited: limited || ranked.length > MAX_GITHUB_PEOPLE,
    viewer
  }
}

// Lower is better: exact login, login prefix, a name word's prefix, then anywhere in either.
function matchRank(person: GitHubPerson, needle: string): number {
  const login = person.login.toLowerCase()
  const name = person.name?.toLowerCase() ?? ''
  if (needle === '' || login === needle) {
    return 0
  }
  if (login.startsWith(needle)) {
    return 1
  }
  if (name.startsWith(needle) || name.split(/\s+/).some((word) => word.startsWith(needle))) {
    return 2
  }
  return login.includes(needle) || name.includes(needle) ? 3 : -1
}

/** Unique people matching `query`, best first; an empty query keeps everyone, by login. */
export function rankGitHubPeople(people: GitHubPerson[], query: string): GitHubPerson[] {
  const needle = query.trim().toLowerCase()
  const byId = new Map<string, { person: GitHubPerson; rank: number }>()
  for (const person of people) {
    const rank = matchRank(person, needle)
    if (rank >= 0 && !byId.has(person.id)) {
      byId.set(person.id, { person, rank })
    }
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.person.login.toLowerCase().localeCompare(right.person.login.toLowerCase())
    )
    .map((entry) => entry.person)
}
