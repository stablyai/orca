import { describe, expect, it, vi } from 'vitest'
import { gitHubPeopleScope } from '../../shared/bots/github-people-scope'
import { BotGitHubPeople } from '../../shared/rpc-contract/bots-connector-setup-params'
import { readRoster, rosterQuery, targetOf } from './github-people-query'
import { GitHubPeopleRosters, type RosterRun } from './github-people-roster'

const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })
const person = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})
const users = (...nodes: unknown[]) => ({ assignableUsers: { totalCount: nodes.length, nodes } })
const json = (data: unknown, errors?: unknown[]) =>
  JSON.stringify({ data, ...(errors ? { errors } : {}) })

const ran = (stdout: string) => vi.fn<RosterRun>(async () => stdout)

describe('reading the people of the connected repositories', () => {
  it('reads people, where they came from and who gh read as, in one call', async () => {
    const rosters = new GitHubPeopleRosters(
      ran(
        json({
          viewer: { login: 'owner' },
          r0: users(person(2, 'brennanb2025', 'Brennan Benson'), person(5, 'jinwoo-h')),
          r1: users(person(2, 'brennanb2025', 'Brennan Benson'))
        })
      ),
      () => 1_000
    )
    expect(await rosters.read(repos('stablyai/orca', 'stablyai/orca-cloud'), 'owner')).toEqual({
      status: 'read',
      people: [
        { id: '2', login: 'brennanb2025', name: 'Brennan Benson' },
        { id: '5', login: 'jinwoo-h', name: null }
      ],
      from: { repositories: true, organizations: false },
      complete: true,
      omitted: false,
      cut: { people: false, members: false, repositories: false },
      readAt: 1_000,
      reused: false,
      readFor: { scope: repos('stablyai/orca', 'stablyai/orca-cloud'), owner: 'owner' },
      searchedAs: 'owner'
    })
  })

  it('is unavailable when no source was read, the viewer alone included', async () => {
    for (const stdout of ['', 'not json', json({ viewer: { login: 'o' } }), json({ r0: null })]) {
      const rosters = new GitHubPeopleRosters(ran(stdout))
      expect(await rosters.read(repos('a/b'), 'owner')).toEqual({
        status: 'unavailable',
        spent: true
      })
    }
    // Nothing readable in the scope: no gh call at all.
    const run = vi.fn<RosterRun>()
    // Nothing readable: no gh ran, nothing spent, and a later valid request still reads.
    const rosters = new GitHubPeopleRosters(run)
    expect(await rosters.read(repos('not a repo'), 'owner')).toEqual({
      status: 'unavailable',
      spent: false
    })
    expect(run).not.toHaveBeenCalled()
    run.mockResolvedValue(json({ r0: users() }))
    expect((await rosters.read(repos('a/b'), 'owner')).status).toBe('read')
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('what a read covered', () => {
  const target = targetOf(repos('a/one', 'a/two')).target
  it.each([
    ['a null source', { r0: users(), r1: null }],
    ['a dropped node', { r0: users(null), r1: users() }],
    ['a malformed node', { r0: users({ login: 'no-id' }), r1: users() }]
  ])('counts %s as lossy, keeping the rest', (_label, data) => {
    const read = readRoster(json(data), target)
    expect(read?.lossy).toBe(true)
    expect(read?.sourcesRead).toBeGreaterThan(0)
  })

  it('counts any GraphQL errors, even a malformed errors field, as lossy while keeping the data', () => {
    const data = { r0: users(person(2, 'x')), r1: users() }
    for (const errors of [[{}], null, { message: 'x' }, 'boom']) {
      const read = readRoster(JSON.stringify({ data, errors }), target)
      expect(read?.lossy, JSON.stringify(errors)).toBe(true)
      expect(read?.people).toEqual([{ id: '2', login: 'x', name: null }])
    }
    expect(readRoster(JSON.stringify({ data, errors: [] }), target)?.lossy).toBe(false)
    // No usable data at all is no read.
    expect(readRoster(JSON.stringify({ errors: [{}] }), target)).toBeNull()
    expect(readRoster(JSON.stringify({ data: null }), target)).toBeNull()
  })

  it('records which kind of read stopped at its fixed size', () => {
    const full = { assignableUsers: { totalCount: 500, nodes: [person(2, 'x')] } }
    expect(readRoster(json({ r0: full, r1: users() }), target)?.cut).toEqual({
      people: true,
      members: false,
      repositories: false
    })
  })

  it('reports scope left out on purpose as omitted, not as a failed read', async () => {
    const rosters = new GitHubPeopleRosters(ran(json({ r0: users() })))
    const roster = await rosters.read({ repositories: ['a/b'], owners: [], more: true }, 'owner')
    expect(roster).toMatchObject({ status: 'read', complete: true, omitted: true })
  })

  it.each([
    ['no repositories at all', [], 1, false, false],
    ['a readable repository with nobody', [users()], 1, true, false],
    ['one readable and one failed repository', [users(person(7, 'kim')), null], 1, true, true],
    ['every repository failed', [null, { assignableUsers: null }], 0, false, true]
  ])(
    "reads a person's whole account with %s",
    (_label, nodes, sourcesRead, fromRepositories, lossy) => {
      const owner = targetOf({ repositories: [], owners: ['amy'], more: false }).target
      const personal = { repositories: { totalCount: nodes.length, nodes } }
      const read = readRoster(json({ a0: personal }), owner)
      expect(read).toMatchObject({
        sourcesRead,
        lossy,
        from: { repositories: fromRepositories, organizations: false }
      })
    }
  )

  it("reads an organization's members as an organization source", () => {
    const owner = targetOf({ repositories: [], owners: ['stablyai'], more: false }).target
    const org = { membersWithRole: { totalCount: 900, nodes: [person(2, 'x')] } }
    expect(readRoster(json({ a0: org }), owner)).toMatchObject({
      sourcesRead: 1,
      cut: { people: false, members: true, repositories: false },
      from: { repositories: false, organizations: true }
    })
    const personal = { repositories: { totalCount: 40, nodes: [users()] } }
    expect(readRoster(json({ a0: personal }), owner)?.cut.repositories).toBe(true)
  })

  it('GPS-C6-07: records which kind of source lost people, or that the kind is unknown', () => {
    const mixed = targetOf({ repositories: ['a/b'], owners: ['acme'], more: false }).target
    const org = { membersWithRole: { totalCount: 1, nodes: [person(2, 'x')] } }
    // Orgs read, the repository failed: a repository loss.
    expect(readRoster(json({ r0: null, a0: org }), mixed)?.lost).toEqual({
      repositories: true,
      organizations: false,
      unattributed: false
    })
    // The repository read, an org member malformed: an organization loss.
    const broken = { membersWithRole: { totalCount: 2, nodes: [person(3, 'y'), { login: 7 }] } }
    expect(readRoster(json({ r0: users(person(2, 'x')), a0: broken }), mixed)?.lost).toEqual({
      repositories: false,
      organizations: true,
      unattributed: false
    })
    // An account that reads as neither kind, or a GraphQL error: the kind can't be told.
    expect(readRoster(json({ r0: users(person(2, 'x')), a0: null }), mixed)?.lost).toMatchObject({
      unattributed: true
    })
    expect(
      readRoster(json({ r0: users(person(2, 'x')), a0: org }, [{ message: 'x' }]), mixed)?.lost
    ).toMatchObject({ unattributed: true })
    expect(readRoster(json({ r0: users(person(2, 'x')), a0: org }), mixed)?.lost).toEqual({
      repositories: false,
      organizations: false,
      unattributed: false
    })
  })

  it('GPS-C7-04: keeps the kind an account declared when its own connection did not read', () => {
    const mixed = targetOf({ repositories: ['a/b'], owners: ['acme', 'amy'], more: false }).target
    const org = {
      __typename: 'Organization',
      membersWithRole: { totalCount: 1, nodes: [person(2, 'x')] }
    }
    const brokenOrg = { __typename: 'Organization', membersWithRole: { totalCount: 'many' } }
    const brokenUser = { __typename: 'User', repositories: null }
    const kinds = (data: Record<string, unknown>, errors?: unknown[]) =>
      readRoster(json(data, errors), mixed)?.lost
    // An org whose members didn't read, while the repo did: an org loss.
    expect(kinds({ r0: users(person(3, 'y')), a0: brokenOrg, a1: org })).toEqual({
      repositories: false,
      organizations: true,
      unattributed: false
    })
    // A person whose repositories didn't read, while an org did: a repo loss.
    expect(kinds({ r0: users(person(3, 'y')), a0: org, a1: brokenUser })).toEqual({
      repositories: true,
      organizations: false,
      unattributed: false
    })
    // An error pointing into that same connection names the same kind, not an unknown one.
    expect(
      kinds({ r0: users(person(3, 'y')), a0: brokenOrg, a1: org }, [
        { message: 'x', path: ['a0', 'membersWithRole'] }
      ])
    ).toEqual({ repositories: false, organizations: true, unattributed: false })
    // A repository's own error is a repository loss.
    expect(
      kinds({ r0: users(person(3, 'y')), a0: org, a1: org }, [{ message: 'x', path: ['r0'] }])
    ).toEqual({ repositories: true, organizations: false, unattributed: false })
    // Null, an unknown kind and an error with no path stay unattributed.
    expect(kinds({ r0: users(person(3, 'y')), a0: null, a1: org })?.unattributed).toBe(true)
    expect(
      kinds({ r0: users(person(3, 'y')), a0: { __typename: 'Bot' }, a1: org })?.unattributed
    ).toBe(true)
    expect(kinds({ r0: users(person(3, 'y')), a0: org, a1: org }, [{ message: 'x' }])).toEqual({
      repositories: false,
      organizations: false,
      unattributed: true
    })
  })

  it('GPS-C8-03: names a lost kind only from an alias this query asked, through its own connection', () => {
    const orgOnly = targetOf({ repositories: [], owners: ['acme'], more: false }).target
    const mixed = targetOf({ repositories: ['a/b'], owners: ['acme'], more: false }).target
    const org = {
      __typename: 'Organization',
      membersWithRole: { totalCount: 1, nodes: [person(2, 'x')] }
    }
    const lost = (target: typeof mixed, data: Record<string, unknown>, path: unknown[]) =>
      readRoster(json(data, [{ message: 'x', path }]), target)?.lost
    const neutral = { repositories: false, organizations: false, unattributed: true }
    // A healthy org-only read: a repository alias it never asked, or an account it never asked
    // (even one the response claims is a User), names no kind.
    expect(lost(orgOnly, { a0: org }, ['r42', 'assignableUsers'])).toEqual(neutral)
    expect(
      lost(orgOnly, { a0: org, a42: { __typename: 'User' } }, ['a42', 'repositories'])
    ).toEqual(neutral)
    // An asked alias through a connection it doesn't select names no kind either.
    expect(lost(mixed, { r0: users(person(3, 'y')), a0: org }, ['a0', 'repositories'])).toEqual(
      neutral
    )
    expect(lost(mixed, { r0: users(person(3, 'y')), a0: org }, ['r0', 'membersWithRole'])).toEqual(
      neutral
    )
    // Through its own connection, or at the alias itself, the kind is named; the other source read.
    expect(lost(mixed, { r0: users(person(3, 'y')), a0: org }, ['r0', 'assignableUsers'])).toEqual({
      repositories: true,
      organizations: false,
      unattributed: false
    })
    expect(
      lost(mixed, { r0: users(person(3, 'y')), a0: org }, ['a0', 'membersWithRole', 'nodes'])
    ).toEqual({
      repositories: false,
      organizations: true,
      unattributed: false
    })
    expect(lost(mixed, { r0: users(person(3, 'y')), a0: org }, ['a0'])).toEqual({
      repositories: false,
      organizations: true,
      unattributed: false
    })
  })

  it('GPS-C7-05: a capped personal account beside a direct repo sets only the per-account cap', () => {
    const mixed = targetOf({ repositories: ['a/b'], owners: ['amy'], more: false }).target
    const personal = {
      __typename: 'User',
      repositories: { totalCount: 40, nodes: [users(person(4, 'z'))] }
    }
    expect(readRoster(json({ r0: users(person(3, 'y')), a0: personal }), mixed)?.cut).toEqual({
      people: false,
      members: false,
      repositories: true
    })
  })

  it('passes names as variables and reads the viewer in the same call', () => {
    const built = rosterQuery({ repositories: [['acme', 'web']], owners: ['org'] })
    expect(built.vars).toEqual({ ro0: 'acme', rn0: 'web', a0: 'org' })
    expect(built.document).not.toContain('acme')
    expect(built.document).toContain('viewer { login }')
  })
})

describe('one roster read per app run', () => {
  it('reuses the one read for every later request, any scope, without another gh call', async () => {
    const run = ran(json({ r0: users(person(2, 'x')) }))
    const rosters = new GitHubPeopleRosters(run, () => 5_000)
    const [first, joined] = await Promise.all([
      rosters.read(repos('a/b'), 'owner'),
      rosters.read(repos('a/b'), 'owner')
    ])
    expect(first).toMatchObject({ status: 'read', reused: false, readAt: 5_000 })
    // A request while the read was running shares it; after, a different scope gets it too.
    expect(joined).toMatchObject({ status: 'read', reused: true })
    expect(await rosters.read(repos('c/d'), 'owner')).toMatchObject({
      status: 'read',
      reused: true,
      readAt: 5_000
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('never runs gh again after a failed read, whatever the failure', async () => {
    const run = ran('')
    const rosters = new GitHubPeopleRosters(run)
    expect(await rosters.read(repos('a/b'), 'owner')).toEqual({
      status: 'unavailable',
      spent: true
    })
    expect(await rosters.read(repos('a/b'), 'owner')).toEqual({
      status: 'unavailable',
      spent: true
    })
    expect(run).toHaveBeenCalledOnce()
    // A run that throws (gh missing included) proves no more than one that answered empty.
    const throwing = vi.fn<RosterRun>(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', syscall: 'spawn gh' })
    })
    const other = new GitHubPeopleRosters(throwing)
    expect(await other.read(repos('a/b'), 'owner')).toEqual({ status: 'unavailable', spent: true })
    await other.read(repos('c/d'), 'other')
    expect(throwing).toHaveBeenCalledOnce()
  })

  it('records what the read was made for, and hands that to every later request', async () => {
    const rosters = new GitHubPeopleRosters(ran(json({ r0: users(person(2, 'x')) })))
    await rosters.read(repos('a/b'), 'alice')
    expect(await rosters.read(repos('c/d'), 'bob')).toMatchObject({
      reused: true,
      readFor: { scope: repos('a/b'), owner: 'alice' }
    })
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
    expect(BotGitHubPeople.safeParse({ scope: one, owner: 'owner' }).success).toBe(true)
  })
})
