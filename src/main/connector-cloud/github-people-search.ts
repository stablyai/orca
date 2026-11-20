// "Who can ask" › Add on GitHub: the people the owner works with, found through the host's own `gh`.
// The cloud only resolves one exact username, so typing a teammate's first name found a stranger.
import * as z from 'zod'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import {
  GITHUB_ID_PATTERN,
  GITHUB_LOGIN_PATTERN,
  type BotGitHubPeople,
  type ConnectorGitHubUsersResponse
} from '../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'

/** Where to look: the connected repositories, and owners whose every repository is connected. */
export type GitHubPeopleScope = {
  repositories: string[]
  organizations: string[]
}

export type GitHubPerson = { id: string; login: string; name: string | null }

// One debounced keystroke is one GraphQL call; these keep its cost and size small.
const MAX_REPOSITORIES = 10
const MAX_ORGANIZATIONS = 3
const PER_REPOSITORY = 30
const ORGANIZATION_MEMBERS = 100
export const MAX_GITHUB_PEOPLE = 30

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PERSON_FIELDS = 'nodes { databaseId login name }'

type Exec = (args: string[]) => Promise<{ stdout: string }>

const ghGraphql: Exec = (args) =>
  ghExecFileAsync(args, {
    encoding: 'utf-8',
    host: 'github.com',
    idempotent: true
  })

function scopeOf(scope: GitHubPeopleScope): {
  repos: [string, string][]
  orgs: string[]
} {
  const repos = new Map<string, [string, string]>()
  for (const fullName of scope.repositories) {
    const [owner, name, extra] = fullName.split('/')
    if (
      extra === undefined &&
      owner &&
      name &&
      GITHUB_LOGIN_PATTERN.test(owner) &&
      REPOSITORY_NAME.test(name)
    ) {
      repos.set(fullName.toLowerCase(), [owner, name])
    }
  }
  const orgs = new Set(scope.organizations.filter((login) => GITHUB_LOGIN_PATTERN.test(login)))
  return {
    repos: [...repos.values()].slice(0, MAX_REPOSITORIES),
    orgs: [...orgs].slice(0, MAX_ORGANIZATIONS)
  }
}

/** The GraphQL document and its variables; names travel as variables, never spliced into the text. */
export function gitHubPeopleQuery(
  query: string,
  scope: GitHubPeopleScope
): { document: string; vars: Record<string, string> } | null {
  const { repos, orgs } = scopeOf(scope)
  if (repos.length === 0 && orgs.length === 0) {
    return null
  }
  // GraphQL rejects a declared variable no field uses, so $q comes only with a repository.
  const params: string[] = repos.length > 0 ? ['$q: String!'] : []
  const fields: string[] = []
  const vars: Record<string, string> = repos.length > 0 ? { q: query } : {}
  repos.forEach(([owner, name], index) => {
    params.push(`$ro${index}: String!`, `$rn${index}: String!`)
    vars[`ro${index}`] = owner
    vars[`rn${index}`] = name
    // Filters on login and name server-side, so a first name finds the teammate.
    fields.push(
      `r${index}: repository(owner: $ro${index}, name: $rn${index}) { assignableUsers(query: $q, first: ${PER_REPOSITORY}) { ${PERSON_FIELDS} } }`
    )
  })
  orgs.forEach((login, index) => {
    params.push(`$o${index}: String!`)
    vars[`o${index}`] = login
    // A user account (not an organization) answers with no members rather than an error.
    fields.push(
      `o${index}: repositoryOwner(login: $o${index}) { ... on Organization { membersWithRole(first: ${ORGANIZATION_MEMBERS}) { ${PERSON_FIELDS} } } }`
    )
  })
  return {
    document: `query(${params.join(', ')}) { ${fields.join(' ')} }`,
    vars
  }
}

// Read leniently: one odd node or one unreadable repository must not lose everyone else.
const RawPerson = z.object({
  databaseId: z.number().int(),
  login: z.string().regex(GITHUB_LOGIN_PATTERN),
  name: z.string().nullable().optional()
})
const People = z.object({ nodes: z.array(z.unknown()) })
const Owner = z
  .object({ assignableUsers: People.optional(), membersWithRole: People.optional() })
  .nullable()
  .catch(null)
const Answer = z.object({ data: z.record(z.string(), Owner).nullable().optional() })

function peopleIn(data: Record<string, z.infer<typeof Owner>>): GitHubPerson[] {
  const people: GitHubPerson[] = []
  for (const owner of Object.values(data)) {
    for (const node of owner?.assignableUsers?.nodes ?? owner?.membersWithRole?.nodes ?? []) {
      const person = RawPerson.safeParse(node)
      const id = person.success ? String(person.data.databaseId) : ''
      if (person.success && GITHUB_ID_PATTERN.test(id)) {
        const name = person.data.name?.trim() || null
        people.push({ id, login: person.data.login, name })
      }
    }
  }
  return people
}

// Lower is better: exact login, login prefix, a name word's prefix, then anywhere in either.
function matchRank(person: GitHubPerson, needle: string): number {
  const login = person.login.toLowerCase()
  const name = person.name?.toLowerCase() ?? ''
  if (needle === '') {
    return 0
  }
  if (login === needle) {
    return 0
  }
  if (login.startsWith(needle)) {
    return 1
  }
  if (name.startsWith(needle) || name.split(/\s+/).some((word) => word.startsWith(needle))) {
    return 2
  }
  if (login.includes(needle) || name.includes(needle)) {
    return 3
  }
  return -1
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
    .slice(0, MAX_GITHUB_PEOPLE)
    .map((entry) => entry.person)
}

/** The people in `scope` matching `query`, best first; null when `gh` could not answer at all
 *  (not installed, signed out, offline), so the caller falls back to the cloud's exact lookup. */
export async function searchGitHubPeople(
  query: string,
  scope: GitHubPeopleScope,
  exec: Exec = ghGraphql
): Promise<GitHubPerson[] | null> {
  const built = gitHubPeopleQuery(query.trim(), scope)
  if (!built) {
    return []
  }
  const args = ['api', 'graphql', '-f', `query=${built.document}`]
  for (const [key, value] of Object.entries(built.vars)) {
    args.push('-f', `${key}=${value}`)
  }
  let stdout: string
  try {
    ;({ stdout } = await exec(args))
  } catch (error) {
    // One repository the gh account can't see fails the call but still answers for the rest.
    stdout = extractExecError(error).stdout
  }
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const parsed = Answer.safeParse(json)
  return parsed.success && parsed.data.data
    ? rankGitHubPeople(peopleIn(parsed.data.data), query)
    : null
}

type CloudUsers = (query: string) => Promise<BotSlackResult<ConnectorGitHubUsersResponse>>

/** The picker's answer: people the owner works with, then anyone on GitHub with exactly that
 *  username, kept apart because they could be a stranger. */
export async function findGitHubPeople(
  cloudUsers: CloudUsers,
  query: string,
  scope: GitHubPeopleScope | undefined,
  exec: Exec = ghGraphql
): Promise<BotSlackResult<BotGitHubPeople>> {
  const login = query.trim()
  const [local, exact] = await Promise.all([
    scope ? searchGitHubPeople(login, scope, exec) : Promise.resolve(null),
    // The cloud answers one exact username; anything else is not worth a round trip.
    GITHUB_LOGIN_PATTERN.test(login) ? cloudUsers(login) : Promise.resolve(null)
  ])
  if (local === null && exact && !exact.ok) {
    return exact
  }
  const people = local ?? []
  const known = new Set(people.map((person) => person.id))
  const members: BotGitHubPeople['members'] = people.map((person) => ({
    id: person.id,
    name: person.login,
    ...(person.name && person.name !== person.login ? { handle: person.name } : {})
  }))
  for (const member of exact?.ok ? exact.value.members : []) {
    if (!known.has(member.id)) {
      members.push({ id: member.id, name: member.name, outside: true })
    }
  }
  return {
    ok: true,
    value: { members, complete: people.length < MAX_GITHUB_PEOPLE }
  }
}
