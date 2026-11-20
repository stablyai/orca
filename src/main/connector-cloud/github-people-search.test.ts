import { describe, expect, it, vi } from 'vitest'
import { gitHubPeopleScope } from '../../shared/bots/github-people-scope'
import { BotGitHubUsers } from '../../shared/rpc-contract/bots-connector-setup-params'
import {
  GitHubPeopleSearch,
  findGitHubPeople,
  peopleQuery,
  rankGitHubPeople,
  type GhRun,
  type GitHubPerson
} from './github-people-search'

const scope = { repositories: ['stablyai/orca', 'stablyai/orca-cloud'], owners: [], more: false }
const person = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})
const users = (...nodes: unknown[]) => ({ assignableUsers: { totalCount: nodes.length, nodes } })
const answering = (data: unknown, errors?: unknown[]): GhRun =>
  vi.fn<GhRun>(async () => JSON.stringify({ data, ...(errors ? { errors } : {}) }))
const exactUser = (id: string, name: string) => async () => ({
  ok: true as const,
  value: { members: [{ id, name }], complete: true }
})
const failing = async () => ({ ok: false as const, error: 'network' })

describe('finding GitHub people for Who can ask', () => {
  it('finds a teammate by first name; the stranger with exactly that username is outside', async () => {
    const local = new GitHubPeopleSearch(
      answering({
        viewer: { login: 'owner' },
        r0: users(person(2, 'brennanb2025', 'Brennan Benson')),
        r1: users(person(2, 'brennanb2025', 'Brennan Benson'))
      })
    )
    expect(await findGitHubPeople(exactUser('9', 'brennan'), 'brennan', scope, local)).toEqual({
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

  it('counts a failed or lossy source as limited, keeping the exact match neutral', async () => {
    const cases: [string, unknown, unknown[]?][] = [
      ['a null source', { r0: users(), r1: null }],
      ['a dropped node', { r0: users(null, person(3, 'x')), r1: users() }],
      ['a malformed node', { r0: users({ login: 'no id' }), r1: users() }],
      ['a GraphQL error', { r0: users(), r1: users() }, [{ type: 'FORBIDDEN' }]]
    ]
    for (const [label, data, errors] of cases) {
      const local = new GitHubPeopleSearch(answering(data, errors))
      const result = await findGitHubPeople(exactUser('9', 'brennan'), 'brennan', scope, local)
      expect(result.ok && result.value.coverage?.local, label).toBe('limited')
      expect(result.ok && result.value.members.at(-1), label).toEqual({
        id: '9',
        name: 'brennan',
        found: 'exact'
      })
    }
  })

  it('treats the viewer alone, or every source failing, as no search at all', async () => {
    const answers = [{ viewer: { login: 'owner' } }, { viewer: { login: 'o' }, r0: null, r1: null }]
    for (const data of answers) {
      const local = new GitHubPeopleSearch(answering(data))
      expect(await local.search('b', scope)).toBeNull()
      // With the exact lookup failing too, the picker gets the error and its retry.
      expect(await findGitHubPeople(failing, 'b', scope, local)).toEqual({
        ok: false,
        error: 'network'
      })
    }
  })

  it('keeps a successful empty search when only the exact lookup failed', async () => {
    const local = new GitHubPeopleSearch(answering({ r0: users(), r1: users() }))
    expect(await findGitHubPeople(failing, 'zed', scope, local)).toEqual({
      ok: true,
      value: { members: [], complete: false, coverage: { local: 'full', exact: 'failed' } }
    })
  })

  it('says GitHub is off whenever the cloud says so', async () => {
    const off = async () => ({ ok: false as const, error: 'github_off' })
    const local = new GitHubPeopleSearch(answering({ r0: users(person(2, 'b')), r1: users() }))
    expect(await findGitHubPeople(off, 'b', scope, local)).toEqual({
      ok: false,
      error: 'github_off'
    })
  })

  it('distinguishes no scope sent, nothing connected, and gh unavailable', async () => {
    const run = vi.fn<GhRun>(async () => '')
    const local = new GitHubPeopleSearch(run)
    const spaced = (s: typeof scope | undefined) => findGitHubPeople(vi.fn(), 'neil par', s, local)
    expect(await spaced(undefined)).toMatchObject({
      value: { coverage: { local: 'skipped', exact: 'skipped' } }
    })
    expect(await spaced({ repositories: [], owners: [], more: false })).toMatchObject({
      value: { coverage: { local: 'none', exact: 'skipped' } }
    })
    expect(await spaced(scope)).toMatchObject({
      value: { members: [], coverage: { local: 'unavailable', exact: 'skipped' } }
    })
    // Only the case with something to search ran gh.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('marks capped matches narrowable, and a cut roster limited but not narrowable', async () => {
    const capped = new GitHubPeopleSearch(
      answering({
        r0: { assignableUsers: { totalCount: 45, nodes: [person(2, 'a1')] } },
        r1: users()
      })
    )
    expect(await capped.search('a', scope)).toMatchObject({ limited: true, narrowable: true })
    const roster = new GitHubPeopleSearch(
      answering({ a0: { membersWithRole: { totalCount: 900, nodes: [person(2, 'x')] } } })
    )
    const org = { repositories: [], owners: ['big'], more: false }
    expect(await roster.search('', org)).toMatchObject({ limited: true, narrowable: false })
  })
})

describe('whole-account installs', () => {
  it("reads an organization's members and a person's own repositories in one call", async () => {
    const run = answering({
      viewer: { login: 'amy' },
      a0: { membersWithRole: { totalCount: 1, nodes: [person(2, 'brennanb2025', 'Brennan')] } },
      a1: { repositories: { totalCount: 1, nodes: [users(person(7, 'kim-dev', 'Kim'))] } }
    })
    const local = new GitHubPeopleSearch(run)
    const owners = { repositories: [], owners: ['stablyai', 'amy'], more: false }
    expect(await local.search('', owners)).toEqual({
      people: [
        { id: '2', login: 'brennanb2025', name: 'Brennan' },
        { id: '7', login: 'kim-dev', name: 'Kim' }
      ],
      limited: false,
      narrowable: false,
      viewer: 'amy'
    })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('the host search lifetime', () => {
  it('aborts the search in flight when a newer one starts, so one gh call is alive', async () => {
    const signals: AbortSignal[] = []
    const run = vi.fn<GhRun>(
      (_args, signal) =>
        new Promise((resolve) => {
          signals.push(signal)
          signal.addEventListener('abort', () => resolve(''))
          if (signals.length === 2) {
            resolve(JSON.stringify({ data: { r0: users(person(2, 'brennan')), r1: users() } }))
          }
        })
    )
    const local = new GitHubPeopleSearch(run)
    const first = local.search('b', scope)
    const second = local.search('br', scope)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(await first).toBeNull()
    expect((await second)?.people).toHaveLength(1)
  })

  it('gives up at the deadline and kills the call, so the exact answer goes out', async () => {
    vi.useFakeTimers()
    try {
      let seen: AbortSignal | undefined
      const run = vi.fn<GhRun>(
        (_args, signal) =>
          new Promise((resolve) => {
            seen = signal
            signal.addEventListener('abort', () => resolve(''))
          })
      )
      const local = new GitHubPeopleSearch(run, 4_000)
      const result = findGitHubPeople(exactUser('9', 'brennan'), 'brennan', scope, local)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(seen?.aborted).toBe(true)
      expect(await result).toMatchObject({
        ok: true,
        value: {
          members: [{ id: '9', name: 'brennan', found: 'exact' }],
          coverage: { local: 'unavailable', exact: 'searched' }
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('queries and ranking', () => {
  it('passes names as variables and reads the viewer in the same call', () => {
    const built = peopleQuery('x', { repositories: [['acme', 'web']], owners: ['org'] })
    expect(built.vars).toEqual({ q: 'x', ro0: 'acme', rn0: 'web', a0: 'org' })
    expect(built.document).not.toContain('acme')
    expect(built.document).toContain('viewer { login }')
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
    expect(BotGitHubUsers.safeParse({ query: 'a', scope: one }).success).toBe(true)
  })
})
