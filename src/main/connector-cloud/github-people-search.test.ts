import { describe, expect, it, vi } from 'vitest'
import { gitHubPeopleScope } from '../../shared/bots/github-people-scope'
import { BotGitHubUsers } from '../../shared/rpc-contract/bots-connector-setup-params'
import {
  GitHubPeopleSearch,
  ROSTER_TTL_MS,
  findGitHubPeople,
  rankGitHubPeople,
  repositoryQuery,
  type GhRun,
  type GitHubPerson
} from './github-people-search'

const scope = {
  repositories: ['stablyai/orca', 'stablyai/orca-cloud'],
  owners: [],
  more: false
}

const person = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})
const users = (...nodes: ReturnType<typeof person>[]) => ({
  assignableUsers: { totalCount: nodes.length, nodes }
})
const answering = (data: unknown): GhRun => vi.fn(async () => JSON.stringify({ data }))

const exactUser = (id: string, name: string) => async () => ({
  ok: true as const,
  value: { members: [{ id, name }], complete: true }
})

describe('finding GitHub people for Who can ask', () => {
  it('finds a teammate by first name; the stranger with exactly that username is outside', async () => {
    const local = new GitHubPeopleSearch(
      answering({
        viewer: { login: 'owner' },
        r0: users(person(2, 'brennanb2025', 'Brennan Benson')),
        r1: users(person(2, 'brennanb2025', 'Brennan Benson'))
      })
    )
    const result = await findGitHubPeople(exactUser('9', 'brennan'), 'brennan', scope, local)
    expect(result).toEqual({
      ok: true,
      value: {
        members: [
          { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', found: 'scope' },
          { id: '9', name: 'brennan', found: 'outside' }
        ],
        complete: true,
        coverage: { local: 'full', exact: 'searched', searchedAs: 'owner' }
      }
    })
  })

  it('does not call an exact match an outsider when part of the scope went unsearched', async () => {
    const local = new GitHubPeopleSearch(
      answering({ viewer: { login: 'owner' }, r0: users(), r1: null })
    )
    const result = await findGitHubPeople(exactUser('9', 'brennan'), 'brennan', scope, local)
    expect(result.ok && result.value.members).toEqual([
      { id: '9', name: 'brennan', found: 'exact' }
    ])
    expect(result.ok && result.value.coverage?.local).toBe('limited')
    expect(result.ok && result.value.complete).toBe(false)
  })

  it('searches a spaced real name without the cloud, and says when gh could not search', async () => {
    const cloud = vi.fn()
    const found = await findGitHubPeople(
      cloud,
      'neil par',
      scope,
      new GitHubPeopleSearch(answering({ r0: users(person(3, 'nwp', 'Neil Parker')), r1: users() }))
    )
    expect(cloud).not.toHaveBeenCalled()
    expect(found.ok && found.value.members).toEqual([
      { id: '3', name: 'nwp', handle: 'Neil Parker', found: 'scope' }
    ])
    const unavailable = await findGitHubPeople(
      cloud,
      'neil par',
      scope,
      new GitHubPeopleSearch(async () => '')
    )
    expect(unavailable).toEqual({
      ok: true,
      value: {
        members: [],
        complete: false,
        coverage: { local: 'unavailable', exact: 'skipped' }
      }
    })
  })

  it('reports a failure when neither side could look, and always when GitHub is off', async () => {
    const failing = async () => ({ ok: false as const, error: 'network' })
    const gh = new GitHubPeopleSearch(async () => '')
    expect(await findGitHubPeople(failing, 'brennan', scope, gh)).toEqual({
      ok: false,
      error: 'network'
    })
    // Nothing connected and the cloud down is a failure too, not "no one found".
    const empty = { repositories: [], owners: [], more: false }
    expect(await findGitHubPeople(failing, 'brennan', empty, gh)).toEqual({
      ok: false,
      error: 'network'
    })
    const off = async () => ({ ok: false as const, error: 'github_off' })
    const working = new GitHubPeopleSearch(answering({ r0: users(person(2, 'brennanb2025')) }))
    expect(await findGitHubPeople(off, 'brennan', scope, working)).toEqual({
      ok: false,
      error: 'github_off'
    })
  })

  it('keeps teammates and says so when only the exact lookup failed', async () => {
    const failing = async () => ({ ok: false as const, error: 'network' })
    const local = new GitHubPeopleSearch(
      answering({ r0: users(person(2, 'brennanb2025')), r1: users() })
    )
    const result = await findGitHubPeople(failing, 'brennan', scope, local)
    expect(result.ok && result.value.members).toEqual([
      { id: '2', name: 'brennanb2025', found: 'scope' }
    ])
    expect(result.ok && result.value.coverage).toEqual({ local: 'full', exact: 'failed' })
    expect(result.ok && result.value.complete).toBe(false)
  })

  it('answers an older caller with no scope from the exact lookup alone', async () => {
    const run = vi.fn<GhRun>()
    const result = await findGitHubPeople(
      exactUser('9', 'brennan'),
      'brennan',
      undefined,
      new GitHubPeopleSearch(run)
    )
    expect(run).not.toHaveBeenCalled()
    expect(result.ok && result.value).toEqual({
      members: [{ id: '9', name: 'brennan', found: 'exact' }],
      complete: false,
      coverage: { local: 'none', exact: 'searched' }
    })
  })

  it('marks the search limited when a repository has more matches than it returned', async () => {
    const local = new GitHubPeopleSearch(
      answering({
        r0: { assignableUsers: { totalCount: 45, nodes: [person(2, 'a1')] } },
        r1: users()
      })
    )
    expect((await local.search('a', scope))?.limited).toBe(true)
  })
})

describe('whole-account installs', () => {
  it('filters an organization roster locally and reads it once per TTL', async () => {
    let now = 0
    const run = vi.fn<GhRun>(async () =>
      JSON.stringify({
        data: {
          viewer: { login: 'owner' },
          a0: {
            membersWithRole: {
              totalCount: 2,
              nodes: [person(2, 'brennanb2025', 'Brennan Benson'), person(5, 'jinwoo-h')]
            }
          }
        }
      })
    )
    const local = new GitHubPeopleSearch(run, () => now)
    const org = { repositories: [], owners: ['stablyai'], more: false }
    const first = await local.search('bren', org)
    expect(first?.people.map((p) => p.login)).toEqual(['brennanb2025'])
    // Read in the roster call itself, so it is who the roster was read as.
    expect(first?.viewer).toBe('owner')
    expect((await local.search('jin', org))?.people.map((p) => p.login)).toEqual(['jinwoo-h'])
    // Read once; later keystrokes filter it with no gh call at all.
    expect(run).toHaveBeenCalledTimes(1)
    now = ROSTER_TTL_MS + 1
    await local.search('jin', org)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("searches a person's own repositories when the app is on their whole account", async () => {
    const run = vi.fn<GhRun>(async (args) =>
      JSON.stringify({
        data: args.join(' ').includes('repositoryOwner')
          ? { a0: { repositories: { totalCount: 1, nodes: [{ nameWithOwner: 'amy/notes' }] } } }
          : { viewer: { login: 'amy' }, r0: users(person(7, 'kim-dev', 'Kim')) }
      })
    )
    const local = new GitHubPeopleSearch(run)
    const found = await local.search('kim', { repositories: [], owners: ['amy'], more: false })
    expect(found).toEqual({
      people: [{ id: '7', login: 'kim-dev', name: 'Kim' }],
      limited: false,
      viewer: 'amy'
    })
    expect(run.mock.calls[1]?.[0]).toContain('ro0=amy')
    expect(run.mock.calls[1]?.[0]).toContain('rn0=notes')
  })

  it('marks a large organization limited', async () => {
    const local = new GitHubPeopleSearch(
      answering({ a0: { membersWithRole: { totalCount: 900, nodes: [person(2, 'x')] } } })
    )
    const found = await local.search('', { repositories: [], owners: ['big'], more: false })
    expect(found?.limited).toBe(true)
  })
})

describe('the host search queue', () => {
  it('runs one gh call at a time and lets a newer search replace the waiting one', async () => {
    const releases: (() => void)[] = []
    let active = 0
    let most = 0
    const run = vi.fn<GhRun>(async () => {
      active += 1
      most = Math.max(most, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return JSON.stringify({ data: { r0: users(person(2, 'brennanb2025')), r1: users() } })
    })
    const local = new GitHubPeopleSearch(run)
    const first = local.search('b', scope)
    const second = local.search('br', scope)
    const third = local.search('bre', scope)
    // The second never started: the third took its place, and it answers null.
    expect(await second).toBeNull()
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases.shift()?.()
    expect((await first)?.people).toHaveLength(1)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases.shift()?.()
    expect((await third)?.people).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(most).toBe(1)
  })
})

describe('queries and ranking', () => {
  it('passes names as variables, and declares $q only when a repository uses it', () => {
    const built = repositoryQuery('x', [['acme', 'web']])
    expect(built.vars).toEqual({ q: 'x', ro0: 'acme', rn0: 'web' })
    expect(built.document).not.toContain('acme')
    expect(built.document).toContain('viewer { login }')
    expect(repositoryQuery('x', []).document).not.toContain('$q')
  })

  it('ranks exact username, then username prefix, then a name word, then anywhere', () => {
    const people: GitHubPerson[] = [
      { id: '1', login: 'xbrenx', name: null },
      { id: '2', login: 'zed', name: 'Sam Bren' },
      { id: '3', login: 'brenda', name: null },
      { id: '4', login: 'bren', name: null },
      { id: '5', login: 'unrelated', name: 'Someone' }
    ]
    expect(rankGitHubPeople(people, 'Bren').map((p) => p.login)).toEqual([
      'bren',
      'brenda',
      'zed',
      'xbrenx'
    ])
  })
})

describe('the scope the renderer sends', () => {
  it('bounds 201 repositories to the RPC limit, deduplicated and in a stable order', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      fullName: `acme/repo-${String(index).padStart(3, '0')}`
    }))
    const one = gitHubPeopleScope([
      { accountLogin: 'acme', repositories: many },
      { accountLogin: 'acme', repositories: [{ fullName: 'ACME/repo-000' }] }
    ])
    const reordered = gitHubPeopleScope([{ accountLogin: 'acme', repositories: many.toReversed() }])
    expect(one.repositories).toHaveLength(10)
    expect(one.repositories).toEqual(reordered.repositories)
    expect(one.more).toBe(true)
    // What the renderer sends always passes the RPC's own validation.
    expect(BotGitHubUsers.safeParse({ query: 'a', scope: one }).success).toBe(true)
    expect(
      gitHubPeopleScope([
        { accountLogin: 'a', repositories: null },
        { accountLogin: 'b', repositories: null },
        { accountLogin: 'c', repositories: null },
        { accountLogin: 'd', repositories: null }
      ])
    ).toEqual({ repositories: [], owners: ['a', 'b', 'c'], more: true })
  })
})
