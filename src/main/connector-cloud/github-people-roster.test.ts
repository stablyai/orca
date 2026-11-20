import { describe, expect, it, vi } from 'vitest'
import type { GhCaptureLifetimeHooks } from '../git/command-runner/hosted-cli/gh-capture-lifetime'
import { gitHubPeopleScope } from '../../shared/bots/github-people-scope'
import { BotGitHubPeople } from '../../shared/rpc-contract/bots-connector-setup-params'
import { readRoster, rosterQuery, targetOf } from './github-people-query'
import { GitHubPeopleRosters, MAX_WAITING_READS, type RosterRun } from './github-people-roster'

const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })
const person = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})
const users = (...nodes: unknown[]) => ({ assignableUsers: { totalCount: nodes.length, nodes } })
const json = (data: unknown, errors?: unknown[]) =>
  JSON.stringify({ data, ...(errors ? { errors } : {}) })

/** A gh call whose answer and whose child's termination the test releases separately. */
function controlled() {
  const calls: {
    args: string[]
    answer: (stdout: string) => void
    terminate: () => void
  }[] = []
  const run = vi.fn<RosterRun>(
    (args, hooks: GhCaptureLifetimeHooks) =>
      new Promise((resolve) => {
        let terminate = (): void => {}
        hooks.onTerminationPending(
          new Promise<void>((done) => {
            terminate = done
          })
        )
        calls.push({ args, answer: resolve, terminate: () => terminate() })
      })
  )
  return { run, calls }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('reading the people of the connected repositories', () => {
  it('reads people, where they came from and who gh read as, in one call', async () => {
    const rosters = new GitHubPeopleRosters(
      vi.fn<RosterRun>(async () =>
        json({
          viewer: { login: 'owner' },
          r0: users(person(2, 'brennanb2025', 'Brennan Benson'), person(5, 'jinwoo-h')),
          r1: users(person(2, 'brennanb2025', 'Brennan Benson'))
        })
      )
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
      searchedAs: 'owner'
    })
  })

  it('is unavailable when no source was read, the viewer alone included', async () => {
    for (const stdout of ['', 'not json', json({ viewer: { login: 'o' } }), json({ r0: null })]) {
      const rosters = new GitHubPeopleRosters(vi.fn<RosterRun>(async () => stdout))
      expect(await rosters.read(repos('a/b'))).toEqual({ status: 'unavailable' })
    }
    // Nothing readable in the scope: no gh call at all.
    const run = vi.fn<RosterRun>()
    expect(await new GitHubPeopleRosters(run).read(repos('not a repo'))).toEqual({
      status: 'unavailable'
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
    const rosters = new GitHubPeopleRosters(vi.fn<RosterRun>(async () => json({ r0: users() })))
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

describe('the host roster slot', () => {
  it('shares one read among callers asking for the same scope', async () => {
    const { run, calls } = controlled()
    const rosters = new GitHubPeopleRosters(run)
    const first = rosters.read(repos('a/b'))
    const second = rosters.read(repos('a/b'))
    await flush()
    expect(run).toHaveBeenCalledOnce()
    calls[0]?.answer(json({ r0: users(person(2, 'x')) }))
    calls[0]?.terminate()
    expect(await first).toEqual(await second)
  })

  it('answers before the child ends, but starts the next read only after it has ended', async () => {
    const { run, calls } = controlled()
    const rosters = new GitHubPeopleRosters(run)
    const first = rosters.read(repos('a/b'))
    const second = rosters.read(repos('c/d'))
    await flush()
    calls[0]?.answer(json({ r0: users(person(2, 'x')) }))
    expect((await first).status).toBe('read')
    await flush()
    // The first child hasn't confirmed it ended: the slot is still held.
    expect(run).toHaveBeenCalledOnce()
    calls[0]?.terminate()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    calls[1]?.answer(json({ r0: users() }))
    calls[1]?.terminate()
    expect((await second).status).toBe('read')
  })

  it('answers every waiting and later read while an end is never confirmed, starting nothing', async () => {
    vi.useFakeTimers()
    try {
      const { run, calls } = controlled()
      const rosters = new GitHubPeopleRosters(run, 1_000)
      const holder = rosters.read(repos('a/b'))
      const waitingB = rosters.read(repos('b/b'))
      const waitingC = rosters.read(repos('c/c'))
      await vi.advanceTimersByTimeAsync(0)
      calls[0]?.answer('')
      expect(await holder).toEqual({ status: 'unavailable' })
      // The holder answered; the queue still holds exactly the two waiting reads.
      expect(rosters.waitingCount).toBe(MAX_WAITING_READS)
      expect(await rosters.read(repos('d/d'))).toEqual({ status: 'busy' })
      // Waiting reads answer busy at their deadline and leave the queue.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await waitingB).toEqual({ status: 'busy' })
      expect(await waitingC).toEqual({ status: 'busy' })
      expect(rosters.waitingCount).toBe(0)
      // A later read waits its turn and answers busy too; the slot is never freed on a timer.
      const later = rosters.read(repos('e/e'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await later).toEqual({ status: 'busy' })
      expect(run).toHaveBeenCalledOnce()
      // Once the end is confirmed, the next read runs.
      calls[0]?.terminate()
      await vi.advanceTimersByTimeAsync(0)
      const recovered = rosters.read(repos('f/f'))
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledTimes(2)
      calls[1]?.answer(json({ r0: users() }))
      calls[1]?.terminate()
      expect((await recovered).status).toBe('read')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets callers for one scope share a waiting read, so repeated asks add no waiters', async () => {
    const { run, calls } = controlled()
    const rosters = new GitHubPeopleRosters(run)
    void rosters.read(repos('a/b'))
    const asks = Array.from({ length: 5 }, () => rosters.read(repos('c/d')))
    expect(rosters.waitingCount).toBe(1)
    await flush()
    calls[0]?.answer('')
    calls[0]?.terminate()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    calls[1]?.answer(json({ r0: users() }))
    calls[1]?.terminate()
    const answers = await Promise.all(asks)
    expect(new Set(answers).size).toBe(1)
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
