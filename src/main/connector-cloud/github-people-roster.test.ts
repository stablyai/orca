import { describe, expect, it, vi } from 'vitest'
import { gitHubPeopleScope } from '../../shared/bots/github-people-scope'
import { BotGitHubPeople } from '../../shared/rpc-contract/bots-connector-setup-params'
import { readRoster, rosterQuery, targetOf } from './github-people-query'
import { GitHubPeopleRosters, failedBeforeSpawn, type RosterRun } from './github-people-roster'

const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })
const person = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})
const users = (...nodes: unknown[]) => ({ assignableUsers: { totalCount: nodes.length, nodes } })
const json = (data: unknown, errors?: unknown[]) =>
  JSON.stringify({ data, ...(errors ? { errors } : {}) })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const ran = (stdout: string, childStarted = true) =>
  vi.fn<RosterRun>(async () => ({ stdout, childStarted }))

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
    expect(await rosters.read(repos('stablyai/orca', 'stablyai/orca-cloud'))).toEqual({
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
      searchedAs: 'owner'
    })
  })

  it('is unavailable when no source was read, the viewer alone included', async () => {
    for (const stdout of ['', 'not json', json({ viewer: { login: 'o' } }), json({ r0: null })]) {
      const rosters = new GitHubPeopleRosters(ran(stdout))
      expect(await rosters.read(repos('a/b'))).toEqual({ status: 'unavailable', retry: 'restart' })
    }
    // Nothing readable in the scope: no gh call at all.
    const run = vi.fn<RosterRun>()
    expect(await new GitHubPeopleRosters(run).read(repos('not a repo'))).toEqual({
      status: 'unavailable',
      retry: 'reopen'
    })
    expect(run).not.toHaveBeenCalled()
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
    const roster = await rosters.read({ repositories: ['a/b'], owners: [], more: true })
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
      rosters.read(repos('a/b')),
      rosters.read(repos('a/b'))
    ])
    expect(first).toMatchObject({ status: 'read', reused: false, readAt: 5_000 })
    // A request while the read was running shares it; after, a different scope gets it too.
    expect(joined).toMatchObject({ status: 'read', reused: true })
    expect(await rosters.read(repos('c/d'))).toMatchObject({
      status: 'read',
      reused: true,
      readAt: 5_000
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('never runs gh again after a read whose child started, even when it failed', async () => {
    const run = ran('', true)
    const rosters = new GitHubPeopleRosters(run)
    expect(await rosters.read(repos('a/b'))).toEqual({ status: 'unavailable', retry: 'restart' })
    expect(await rosters.read(repos('a/b'))).toEqual({ status: 'unavailable', retry: 'restart' })
    expect(run).toHaveBeenCalledOnce()
    // A run that throws can't say a child never started: the same.
    const throwing = vi.fn<RosterRun>(async () => {
      throw new Error('boom')
    })
    const other = new GitHubPeopleRosters(throwing)
    expect(await other.read(repos('a/b'))).toEqual({ status: 'unavailable', retry: 'restart' })
    await other.read(repos('a/b'))
    expect(throwing).toHaveBeenCalledOnce()
  })

  it('tries again on the next request when no gh child was ever started', async () => {
    const run = vi
      .fn<RosterRun>()
      .mockResolvedValueOnce({ stdout: '', childStarted: false })
      .mockResolvedValueOnce({ stdout: json({ r0: users(person(2, 'x')) }), childStarted: true })
    const rosters = new GitHubPeopleRosters(run)
    expect(await rosters.read(repos('a/b'))).toEqual({ status: 'unavailable', retry: 'reopen' })
    await flush()
    expect((await rosters.read(repos('a/b'))).status).toBe('read')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('tells a failure before any process existed from one after', () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn gh'
    })
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES', syscall: 'spawn' })
    const exited = Object.assign(new Error('gh exited 1'), { code: 1, stderr: 'not logged in' })
    expect(failedBeforeSpawn(missing)).toBe(true)
    expect(failedBeforeSpawn(denied)).toBe(true)
    expect(failedBeforeSpawn(exited)).toBe(false)
    expect(failedBeforeSpawn(new Error('timed out'))).toBe(false)
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
    expect(BotGitHubPeople.safeParse({ scope: one }).success).toBe(true)
  })
})
