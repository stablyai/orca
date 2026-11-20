import { describe, expect, it, vi } from 'vitest'
import {
  findGitHubPeople,
  gitHubPeopleQuery,
  rankGitHubPeople,
  searchGitHubPeople,
  type GitHubPerson
} from './github-people-search'

const scope = { repositories: ['stablyai/orca', 'stablyai/orca-cloud'], organizations: [] }

function ghAnswering(data: unknown) {
  return vi.fn(async (_args: string[]) => ({ stdout: JSON.stringify({ data }) }))
}

const node = (databaseId: number, login: string, name: string | null = null) => ({
  databaseId,
  login,
  name
})

describe('finding GitHub people for Who can ask', () => {
  it('finds a teammate by first name before the stranger whose username is exactly that name', async () => {
    const exec = ghAnswering({
      r0: { assignableUsers: { nodes: [node(2, 'brennanb2025', 'Brennan Benson')] } },
      r1: { assignableUsers: { nodes: [node(2, 'brennanb2025', 'Brennan Benson')] } }
    })
    const cloud = vi.fn(async () => ({
      ok: true as const,
      value: { members: [{ id: '9', name: 'brennan' }], complete: true }
    }))

    const result = await findGitHubPeople(cloud, 'brennan', scope, exec)

    expect(cloud).toHaveBeenCalledWith('brennan')
    expect(result).toEqual({
      ok: true,
      value: {
        members: [
          { id: '2', name: 'brennanb2025', handle: 'Brennan Benson' },
          { id: '9', name: 'brennan', outside: true }
        ],
        complete: true
      }
    })
  })

  it('does not list a teammate twice when the exact lookup finds them too', async () => {
    const exec = ghAnswering({
      r0: { assignableUsers: { nodes: [node(5, 'jinwoo-h', 'Jinwoo')] } }
    })
    const cloud = async () => ({
      ok: true as const,
      value: { members: [{ id: '5', name: 'jinwoo-h' }], complete: true }
    })
    const result = await findGitHubPeople(cloud, 'jinwoo-h', scope, exec)
    expect(result.ok && result.value.members).toEqual([
      { id: '5', name: 'jinwoo-h', handle: 'Jinwoo' }
    ])
  })

  it('searches by real name with spaces without asking the cloud for a username it cannot be', async () => {
    const exec = ghAnswering({
      r0: { assignableUsers: { nodes: [node(3, 'nwp', 'Neil Parker')] } }
    })
    const cloud = vi.fn()
    const result = await findGitHubPeople(cloud, 'neil par', scope, exec)
    expect(cloud).not.toHaveBeenCalled()
    expect(result.ok && result.value.members).toEqual([
      { id: '3', name: 'nwp', handle: 'Neil Parker' }
    ])
  })

  it("falls back to the cloud's answer, error included, when gh cannot answer", async () => {
    const exec = vi.fn(async () => {
      throw new Error('gh: command not found')
    })
    const failing = async () => ({ ok: false as const, error: 'github_off' })
    expect(await findGitHubPeople(failing, 'brennan', scope, exec)).toEqual({
      ok: false,
      error: 'github_off'
    })
    const found = async () => ({
      ok: true as const,
      value: { members: [{ id: '9', name: 'brennan' }], complete: true }
    })
    const result = await findGitHubPeople(found, 'brennan', scope, exec)
    expect(result.ok && result.value.members).toEqual([{ id: '9', name: 'brennan', outside: true }])
  })

  it('keeps the repositories gh could read when another one fails', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify({
          data: { r0: { assignableUsers: { nodes: [node(4, 'amethyst')] } }, r1: null },
          errors: [{ type: 'NOT_FOUND' }]
        }),
        stderr: ''
      })
    })
    expect(await searchGitHubPeople('ame', scope, exec)).toEqual([
      { id: '4', login: 'amethyst', name: null }
    ])
  })

  it('passes repository names as variables, never inside the query text', () => {
    const built = gitHubPeopleQuery('x', {
      repositories: ['acme/web', 'evil/"){a}', 'too/many/parts'],
      organizations: ['acme', 'bad login']
    })
    expect(built?.vars).toEqual({ q: 'x', ro0: 'acme', rn0: 'web', o0: 'acme' })
    expect(built?.document).not.toContain('acme')
    expect(gitHubPeopleQuery('x', { repositories: [], organizations: [] })).toBeNull()
  })

  it('declares the query variable only when a repository uses it', () => {
    const built = gitHubPeopleQuery('bren', { repositories: [], organizations: ['acme'] })
    expect(built?.vars).toEqual({ o0: 'acme' })
    expect(built?.document).not.toContain('$q')
  })

  it('ranks exact username, then username prefix, then a name word, then anywhere', () => {
    const people: GitHubPerson[] = [
      { id: '1', login: 'xbrenx', name: null },
      { id: '2', login: 'zed', name: 'Sam Bren' },
      { id: '3', login: 'brenda', name: null },
      { id: '4', login: 'bren', name: null },
      { id: '5', login: 'unrelated', name: 'Someone' }
    ]
    expect(rankGitHubPeople(people, 'Bren').map((person) => person.login)).toEqual([
      'bren',
      'brenda',
      'zed',
      'xbrenx'
    ])
  })
})
