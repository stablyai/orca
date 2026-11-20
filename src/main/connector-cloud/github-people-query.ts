// Who can ask › Add on GitHub: the one GraphQL call the host's gh runs per search, how its answer
// is read source by source, and how the people found are ranked.
import * as z from 'zod'
import { GITHUB_ID_PATTERN, GITHUB_LOGIN_PATTERN } from '../../shared/connector-bot-github-contract'
import {
  GITHUB_PEOPLE_MAX_OWNERS,
  GITHUB_PEOPLE_MAX_REPOSITORIES
} from '../../shared/bots/github-people-scope'

export type GitHubPerson = { id: string; login: string; name: string | null }

const PER_REPOSITORY = 30
const ORGANIZATION_MEMBERS = 100
/** A personal account's own repositories searched, most recently pushed first. */
const PERSONAL_REPOSITORIES = 5
const PER_PERSONAL_REPOSITORY = 10
export const MAX_GITHUB_PEOPLE = 30

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PERSON = 'nodes { databaseId login name } totalCount'

export type GitHubPeopleTarget = { repositories: [string, string][]; owners: string[] }

/** The searchable part of a scope; anything dropped (malformed, over the caps) is reported. */
export function targetOf(scope: { repositories: string[]; owners: string[] }): {
  target: GitHubPeopleTarget
  dropped: boolean
} {
  const repositories: [string, string][] = []
  for (const fullName of scope.repositories) {
    const [owner, name, extra] = fullName.split('/')
    if (extra === undefined && owner && name && GITHUB_LOGIN_PATTERN.test(owner)) {
      if (REPOSITORY_NAME.test(name)) {
        repositories.push([owner, name])
      }
    }
  }
  const owners = scope.owners.filter((login) => GITHUB_LOGIN_PATTERN.test(login))
  const target = {
    repositories: repositories.slice(0, GITHUB_PEOPLE_MAX_REPOSITORIES),
    owners: owners.slice(0, GITHUB_PEOPLE_MAX_OWNERS)
  }
  const kept = target.repositories.length + target.owners.length
  return { target, dropped: kept < scope.repositories.length + scope.owners.length }
}

/** One call: the viewer (who gh searches as) and every source, so all results share that
 *  principal. Names travel as variables, never spliced into the text. */
export function peopleQuery(
  query: string,
  target: GitHubPeopleTarget
): { document: string; vars: Record<string, string> } {
  const { repositories, owners } = target
  // GraphQL rejects a declared variable no field uses; repositories and personal accounts use $q.
  const usesQuery = repositories.length > 0 || owners.length > 0
  const params: string[] = usesQuery ? ['$q: String!'] : []
  const vars: Record<string, string> = usesQuery ? { q: query } : {}
  const fields: string[] = ['viewer { login }']
  repositories.forEach(([owner, name], index) => {
    params.push(`$ro${index}: String!`, `$rn${index}: String!`)
    vars[`ro${index}`] = owner
    vars[`rn${index}`] = name
    fields.push(
      `r${index}: repository(owner: $ro${index}, name: $rn${index}) { assignableUsers(query: $q, first: ${PER_REPOSITORY}) { ${PERSON} } }`
    )
  })
  owners.forEach((login, index) => {
    params.push(`$a${index}: String!`)
    vars[`a${index}`] = login
    fields.push(
      `a${index}: repositoryOwner(login: $a${index}) { __typename ` +
        `... on Organization { membersWithRole(first: ${ORGANIZATION_MEMBERS}) { ${PERSON} } } ` +
        `... on User { repositories(first: ${PERSONAL_REPOSITORIES}, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) { totalCount nodes { assignableUsers(query: $q, first: ${PER_PERSONAL_REPOSITORY}) { ${PERSON} } } } } }`
    )
  })
  return { document: `query(${params.join(', ')}) { ${fields.join(' ')} }`, vars }
}

const RawPerson = z.object({
  databaseId: z.number().int(),
  login: z.string().regex(GITHUB_LOGIN_PATTERN),
  name: z.string().nullable().optional()
})
const People = z.object({ totalCount: z.number().int(), nodes: z.array(z.unknown()) })
const RepositorySource = z.object({ assignableUsers: People })
const OrganizationSource = z.object({ membersWithRole: People })
const PersonalSource = z.object({
  repositories: z.object({ totalCount: z.number().int(), nodes: z.array(z.unknown()) })
})
const Answer = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(z.unknown()).optional()
})
const Viewer = z.object({ login: z.string().regex(GITHUB_LOGIN_PATTERN) })

/** What one call found, source by source. */
export type PeopleRead = {
  people: GitHubPerson[]
  /** Sources (a repository, an organization, a personal account) read successfully. */
  sourcesRead: number
  /** Some source failed or lost entries (null or malformed nodes, a GraphQL error). */
  lossy: boolean
  /** A source held more people than it returned for this query: typing more narrows it. */
  matchesCapped: boolean
  /** A source's population was cut regardless of the query (an organization's first
   *  ORGANIZATION_MEMBERS, a person's first PERSONAL_REPOSITORIES repositories). */
  scopeCut: boolean
  viewer: string | null
}

export function readPeople(stdout: string, target: GitHubPeopleTarget): PeopleRead | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const answer = Answer.safeParse(raw)
  const data = answer.success ? answer.data.data : null
  if (!data) {
    return null
  }
  const read: PeopleRead = {
    people: [],
    sourcesRead: 0,
    lossy: (answer.success && (answer.data.errors?.length ?? 0) > 0) || false,
    matchesCapped: false,
    scopeCut: false,
    viewer: null
  }
  const viewer = Viewer.safeParse(data.viewer)
  read.viewer = viewer.success ? viewer.data.login : null
  const take = (connection: z.infer<typeof People>, onCut: 'matches' | 'scope'): void => {
    for (const node of connection.nodes) {
      const person = RawPerson.safeParse(node)
      const id = person.success ? String(person.data.databaseId) : ''
      if (person.success && GITHUB_ID_PATTERN.test(id)) {
        read.people.push({ id, login: person.data.login, name: person.data.name?.trim() || null })
      } else {
        read.lossy = true
      }
    }
    if (connection.totalCount > connection.nodes.length) {
      if (onCut === 'matches') {
        read.matchesCapped = true
      } else {
        read.scopeCut = true
      }
    }
  }
  target.repositories.forEach((_repo, index) => {
    const source = RepositorySource.safeParse(data[`r${index}`])
    if (source.success) {
      read.sourcesRead += 1
      take(source.data.assignableUsers, 'matches')
    } else {
      read.lossy = true
    }
  })
  target.owners.forEach((_owner, index) => {
    const entry = data[`a${index}`]
    const organization = OrganizationSource.safeParse(entry)
    const personal = PersonalSource.safeParse(entry)
    if (organization.success) {
      read.sourcesRead += 1
      // A fixed roster, filtered here: typing more doesn't bring in members past the first page.
      take(organization.data.membersWithRole, 'scope')
    } else if (personal.success) {
      read.sourcesRead += 1
      read.scopeCut ||=
        personal.data.repositories.totalCount > personal.data.repositories.nodes.length
      for (const repo of personal.data.repositories.nodes) {
        const source = RepositorySource.safeParse(repo)
        if (source.success) {
          take(source.data.assignableUsers, 'matches')
        } else {
          read.lossy = true
        }
      }
    } else {
      read.lossy = true
    }
  })
  return read
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
