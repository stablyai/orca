// Who can ask › Add on GitHub: the one GraphQL call that reads the people of the connected
// repositories and organizations, and how its answer is read source by source.
import * as z from 'zod'
import {
  GITHUB_ID_PATTERN,
  GITHUB_LOGIN_PATTERN,
  GITHUB_PEOPLE_PER_SOURCE,
  GITHUB_PERSONAL_REPOSITORIES
} from '../../shared/connector-bot-github-contract'
import {
  GITHUB_PEOPLE_MAX_OWNERS,
  GITHUB_PEOPLE_MAX_REPOSITORIES,
  type GitHubPeopleScope
} from '../../shared/bots/github-people-scope'
import type { GitHubPerson } from '../../shared/bots/github-people-rank'

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PEOPLE = `assignableUsers(first: ${GITHUB_PEOPLE_PER_SOURCE}) { totalCount nodes { databaseId login name } }`

export type GitHubPeopleTarget = { repositories: [string, string][]; owners: string[] }

/** The readable part of a scope; anything dropped (malformed, over the caps) is reported. */
export function targetOf(scope: GitHubPeopleScope): {
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

/** One call: the viewer (who gh reads as) and every source, so all people share that principal.
 *  Names travel as variables, never spliced into the text. */
export function rosterQuery(target: GitHubPeopleTarget): {
  document: string
  vars: Record<string, string>
} {
  const params: string[] = []
  const vars: Record<string, string> = {}
  const fields: string[] = ['viewer { login }']
  target.repositories.forEach(([owner, name], index) => {
    params.push(`$ro${index}: String!`, `$rn${index}: String!`)
    vars[`ro${index}`] = owner
    vars[`rn${index}`] = name
    fields.push(`r${index}: repository(owner: $ro${index}, name: $rn${index}) { ${PEOPLE} }`)
  })
  target.owners.forEach((login, index) => {
    params.push(`$a${index}: String!`)
    vars[`a${index}`] = login
    fields.push(
      `a${index}: repositoryOwner(login: $a${index}) { __typename ` +
        `... on Organization { membersWithRole(first: ${GITHUB_PEOPLE_PER_SOURCE}) { totalCount nodes { databaseId login name } } } ` +
        `... on User { repositories(first: ${GITHUB_PERSONAL_REPOSITORIES}, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) { totalCount nodes { ${PEOPLE} } } } }`
    )
  })
  const head = params.length > 0 ? `query(${params.join(', ')})` : 'query'
  return { document: `${head} { ${fields.join(' ')} }`, vars }
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
// Data and errors are read apart: a malformed `errors` must not lose readable sources.
const Data = z.object({ data: z.record(z.string(), z.unknown()) })
const NoErrors = z.object({ errors: z.array(z.never()).optional() })
const Viewer = z.object({ login: z.string().regex(GITHUB_LOGIN_PATTERN) })

/** What one call returned, source by source. */
export type RosterRead = {
  people: GitHubPerson[]
  /** Sources read: a repository's people, an organization's members, or a personal account
   *  (its repository list, plus at least one of its repositories' people when it has any). */
  sourcesRead: number
  from: { repositories: boolean; organizations: boolean }
  /** A source failed or lost entries: a null or malformed source or node, a GraphQL error. */
  lossy: boolean
  /** Sources that stopped at their fixed size, by kind. */
  cut: { people: boolean; members: boolean; repositories: boolean }
  viewer: string | null
}

export function readRoster(stdout: string, target: GitHubPeopleTarget): RosterRead | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const parsed = Data.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const data = parsed.data.data
  const viewer = Viewer.safeParse(data.viewer)
  const read: RosterRead = {
    people: [],
    sourcesRead: 0,
    from: { repositories: false, organizations: false },
    // Any errors entry, or an `errors` that isn't a list at all, means something was lost.
    lossy: !NoErrors.safeParse(raw).success,
    cut: { people: false, members: false, repositories: false },
    viewer: viewer.success ? viewer.data.login : null
  }
  const take = (connection: z.infer<typeof People>, kind: 'people' | 'members'): void => {
    for (const node of connection.nodes) {
      const person = RawPerson.safeParse(node)
      const id = person.success ? String(person.data.databaseId) : ''
      if (person.success && GITHUB_ID_PATTERN.test(id)) {
        read.people.push({ id, login: person.data.login, name: person.data.name?.trim() || null })
      } else {
        read.lossy = true
      }
    }
    read.cut[kind] ||= connection.totalCount > connection.nodes.length
  }
  target.repositories.forEach((_repo, index) => {
    const source = RepositorySource.safeParse(data[`r${index}`])
    if (source.success) {
      read.sourcesRead += 1
      read.from.repositories = true
      take(source.data.assignableUsers, 'people')
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
      read.from.organizations = true
      take(organization.data.membersWithRole, 'members')
      return
    }
    if (!personal.success) {
      read.lossy = true
      return
    }
    const repositories = personal.data.repositories
    read.cut.repositories ||= repositories.totalCount > repositories.nodes.length
    let readable = 0
    for (const repo of repositories.nodes) {
      const source = RepositorySource.safeParse(repo)
      if (source.success) {
        readable += 1
        take(source.data.assignableUsers, 'people')
      } else {
        read.lossy = true
      }
    }
    // An account with no repositories was read whole; one whose repositories all failed was not.
    if (repositories.nodes.length === 0 || readable > 0) {
      read.sourcesRead += 1
      read.from.repositories ||= readable > 0
    }
  })
  return read
}
