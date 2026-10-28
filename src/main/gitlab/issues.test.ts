import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getIssueProjectRefMock,
  resolveIssueSourceMock,
  getGlabKnownHostsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getIssueProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    glabApiWithHeaders: glabApiWithHeadersMock,
    getIssueProjectRef: getIssueProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { parseGlabApiResponse } from './gl-utils'
import { addIssueComment, createIssue, getIssue, listIssues } from './issues'
import { updateIssue } from './issue-update'
import { listAssignableUsers, listLabels } from './project-label-and-member-lookup'

function glabIncludeOutput(headers: Record<string, string>, body: unknown): string {
  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')
  return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${headerLines}\r\n${JSON.stringify(body)}\n`
}

function serveGlabApiPages(stdoutByEndpoint: Map<string, string>): void {
  glabApiWithHeadersMock.mockImplementation(async (args: string[]) => {
    const stdout = stdoutByEndpoint.get(args.at(-1) ?? '')
    if (stdout === undefined) {
      throw new Error(`unexpected glab api call: ${args.join(' ')}`)
    }
    return parseGlabApiResponse(stdout)
  })
}

/** Model glab assignment parsing: + adds, -/! removes, unprefixed names replace everyone. */
function glabAssigneeEdits(args: string[]): { add: string[]; remove: string[]; replace: string[] } {
  const add: string[] = []
  const remove: string[] = []
  const replace: string[] = []
  for (const arg of args) {
    if (!arg.startsWith('--assignee=')) {
      continue
    }
    for (const value of arg.slice('--assignee='.length).split(',')) {
      if (value.startsWith('+')) {
        add.push(value.slice(1))
      } else if (value.startsWith('-') || value.startsWith('!')) {
        remove.push(value.slice(1))
      } else {
        replace.push(value)
      }
    }
  }
  return { add, remove, replace }
}

describe('gitlab issue operations', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    glabApiWithHeadersMock.mockReset()
    getIssueProjectRefMock.mockReset()
    resolveIssueSourceMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueProjectRefMock(),
      fellBack: false
    }))
  })

  it('gets a single issue from the project ref', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        iid: 923,
        title: 'Use upstream issues',
        state: 'opened',
        web_url: 'https://gitlab.com/stablyai/orca/-/issues/923',
        labels: []
      })
    })

    await expect(getIssue('/repo-root', 923)).resolves.toMatchObject({ number: 923 })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/stablyai%2Forca/issues/923'],
      { cwd: '/repo-root' }
    )
  })

  it('routes local WSL issue operations through project resolution and glab execution options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getIssueProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'stablyai/orca' })
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
    glabExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 923,
          title: 'Use WSL',
          state: 'opened',
          web_url: 'https://gitlab.com/stablyai/orca/-/issues/923',
          labels: []
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 924,
          web_url: 'https://gitlab.com/stablyai/orca/-/issues/924'
        })
      })
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 1,
          author: { username: 'octo', avatar_url: '', state: 'active' },
          body: 'Comment',
          created_at: '2026-06-16T00:00:00.000Z'
        })
      })
    glabApiWithHeadersMock
      .mockResolvedValueOnce({ body: '[]', headers: {} })
      .mockResolvedValueOnce({ body: '[{"id":1,"name":"bug"}]', headers: { 'x-next-page': '' } })
      .mockResolvedValueOnce({
        body: '[{"id":1,"username":"octo","avatar_url":""}]',
        headers: { 'x-next-page': '' }
      })

    await getIssue('/repo-root', 923, null, localGitOptions)
    await listIssues('/repo-root', 5, undefined, 'opened', undefined, null, localGitOptions)
    await createIssue('/repo-root', 'New issue', 'Body', undefined, null, localGitOptions)
    await updateIssue(
      '/repo-root',
      923,
      { body: 'Updated' },
      undefined,
      null,
      null,
      localGitOptions
    )
    await addIssueComment('/repo-root', 923, 'Comment', undefined, null, null, localGitOptions)
    await expect(listLabels('/repo-root', undefined, null, localGitOptions)).resolves.toEqual([
      'bug'
    ])
    await expect(
      listAssignableUsers('/repo-root', undefined, null, localGitOptions)
    ).resolves.toMatchObject([{ username: 'octo' }])

    expect(getIssueProjectRefMock).toHaveBeenCalledWith(
      '/repo-root',
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(glabExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(3)
    expect(glabApiWithHeadersMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
      [
        'projects/stablyai%2Forca/issues?page=1&per_page=5&order_by=updated_at&sort=desc&state=opened'
      ],
      { cwd: '/repo-root', ...localGitOptions }
    )
  })

  it('encodes nested group paths', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({
      host: 'gitlab.com',
      path: 'group/subgroup/project'
    })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ iid: 1, title: 't', state: 'opened' })
    })

    await getIssue('/repo-root', 1)
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/group%2Fsubgroup%2Fproject/issues/1'],
      { cwd: '/repo-root' }
    )
  })

  it('lists issues with state=opened ordering', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: '[]',
      headers: { 'x-total': '123', 'x-total-pages': '25' }
    })

    await expect(listIssues('/repo-root', 5)).resolves.toEqual({ items: [], totalPages: 25 })

    expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
      [
        'projects/stablyai%2Forca/issues?page=1&per_page=5&order_by=updated_at&sort=desc&state=opened'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('forwards an explicit page into the issues API path after localGitOptions', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })

    await expect(
      listIssues('/repo-root', 50, undefined, 'opened', undefined, null, {}, 3)
    ).resolves.toMatchObject({ totalPages: 3 })

    expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
      [
        'projects/stablyai%2Forca/issues?page=3&per_page=50&order_by=updated_at&sort=desc&state=opened'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('derives total pages from x-total when x-total-pages is unavailable', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: { 'x-total': '11' } })

    await expect(listIssues('/repo-root', 5)).resolves.toMatchObject({ totalPages: 3 })
  })

  it('keeps a next-page probe when a proxy strips pagination headers', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: JSON.stringify(
        Array.from({ length: 5 }, (_, index) => ({
          iid: index + 1,
          title: `Issue ${index + 1}`,
          state: 'opened',
          web_url: `https://gitlab.com/stablyai/orca/-/issues/${index + 1}`,
          labels: []
        }))
      ),
      headers: {}
    })

    await expect(listIssues('/repo-root', 5)).resolves.toMatchObject({ totalPages: 2 })
  })

  it('surfaces a permission_denied error instead of collapsing to empty', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('reports the body instead of ".map is not a function" when the API returns a non-array', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: JSON.stringify({ data: [], total: 0 }),
      headers: {}
    })

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('unknown')
    expect(result.error?.message).toContain('{"data":[],"total":0}')
    expect(result.error?.message).not.toContain('is not a function')
  })

  it('reports a GitLab error envelope by its own message', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: JSON.stringify({ message: '403 Forbidden' }),
      headers: {}
    })

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('returns an isolated not_found error (never a cwd-inferred glab call) when the project is unresolved', async () => {
    // Unresolved SSH projects must return an isolated error without attempting local cwd inference.
    getIssueProjectRefMock.mockResolvedValueOnce(null)

    const result = await listIssues('/repo-root', 5, undefined, 'opened', '@me')

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('not_found')
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('returns null for getIssue (and spawns no glab call) when the project is unresolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)

    await expect(getIssue('/repo-root', 7)).resolves.toBeNull()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('threads connectionId into getGlabKnownHosts for listIssues', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })

    await listIssues('/repo-root', 5, undefined, 'opened', undefined, 'conn-7')

    expect(getGlabKnownHostsMock).toHaveBeenCalledWith('conn-7', {})
  })

  it('creates an issue and returns its iid + web_url', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        iid: 924,
        web_url: 'https://gitlab.com/stablyai/orca/-/issues/924'
      })
    })

    await expect(createIssue('/repo-root', 'New issue', 'Body')).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://gitlab.com/stablyai/orca/-/issues/924'
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'projects/stablyai%2Forca/issues',
        '-f',
        'title=New issue',
        '-f',
        'description=Body'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('rejects createIssue with empty title', async () => {
    await expect(createIssue('/repo-root', '   ', 'body')).resolves.toEqual({
      ok: false,
      error: 'Title is required'
    })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('updateIssue closes via `glab issue close` when state=closed', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toEqual({ ok: true })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'close', '5', '-R', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
  })

  // issue update rejects --hostname; pass the instance through GITLAB_HOST.
  it('updateIssue edits fields through GITLAB_HOST on an SSH workspace', async () => {
    const projectRef = { host: 'gitlab.example.internal', path: 'stablyai/orca' }
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 5, { title: 'Renamed' }, undefined, 'conn-1', projectRef)
    ).resolves.toEqual({ ok: true })

    const [args, options] = glabExecFileAsyncMock.mock.calls[0]
    expect(args.slice(0, 2)).toEqual(['issue', 'update'])
    expect(args).not.toContain('--hostname')
    expect(options.env?.GITLAB_HOST).toBe('gitlab.example.internal')
  })

  it('updateIssue closes through GITLAB_HOST on an SSH workspace', async () => {
    const projectRef = { host: 'gitlab.example.internal', path: 'stablyai/orca' }
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 5, { state: 'closed' }, undefined, 'conn-1', projectRef)
    ).resolves.toEqual({ ok: true })

    const [args, options] = glabExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(['issue', 'close', '5', '-R', 'stablyai/orca'])
    expect(options.env?.GITLAB_HOST).toBe('gitlab.example.internal')
  })

  // glab already-closed success exits 0; an already substring must not hide a real rejection.
  it('updateIssue reports a failed close even when its text says "already"', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('Issue is already closed'))

    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toMatchObject({
      ok: false
    })
  })

  it('updateIssue applies field edits via `glab issue update`', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 5, {
        title: 'Renamed',
        addLabels: ['bug'],
        removeLabels: ['stale'],
        addAssignees: ['alice'],
        removeAssignees: ['bob']
      })
    ).resolves.toEqual({ ok: true })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'issue',
        'update',
        '5',
        '-R',
        'stablyai/orca',
        '--title',
        'Renamed',
        '--label',
        'bug',
        '--unlabel',
        'stale',
        '--assignee=+alice',
        '--assignee=-bob'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('updateIssue sends assignee edits glab applies as add/remove, never as a replace', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await updateIssue('/repo-root', 5, {
      addAssignees: ['alice', 'carol'],
      removeAssignees: ['bob']
    })

    const [args] = glabExecFileAsyncMock.mock.calls[0]
    expect(glabAssigneeEdits(args)).toEqual({
      add: ['alice', 'carol'],
      remove: ['bob'],
      replace: []
    })
    expect(args.filter((arg: string) => arg.startsWith('--unassign'))).toEqual([])
  })

  it('updateIssue applies body edits via the issue API', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 5, { body: 'Updated body' })).resolves.toEqual({
      ok: true
    })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'PUT', 'projects/stablyai%2Forca/issues/5', '-f', 'description=Updated body'],
      { cwd: '/repo-root' }
    )
  })

  it('walks label and member pages of glab api -i output on the selected SSH GitLab host', async () => {
    getIssueProjectRefMock
      .mockResolvedValueOnce({ host: 'git.internal', path: 'stablyai/orca' })
      .mockResolvedValueOnce({ host: 'git.internal', path: 'stablyai/orca' })
    serveGlabApiPages(
      new Map([
        [
          'projects/stablyai%2Forca/labels?per_page=100&page=1',
          glabIncludeOutput({ 'X-Next-Page': '2', 'X-Page': '1', 'X-Total-Pages': '2' }, [
            { id: 1, name: 'bug', color: '#d9534f', is_project_label: true }
          ])
        ],
        [
          'projects/stablyai%2Forca/labels?per_page=100&page=2',
          glabIncludeOutput({ 'X-Next-Page': '', 'X-Page': '2', 'X-Total-Pages': '2' }, [
            { id: 4, name: 'feature', color: '#f0ad4e', is_project_label: false }
          ])
        ],
        [
          'projects/stablyai%2Forca/members/all?per_page=100&page=1',
          glabIncludeOutput({ 'X-Next-Page': '', 'X-Page': '1' }, [
            {
              id: 12,
              username: 'alice',
              name: 'Alice',
              state: 'active',
              avatar_url: 'https://example.com/a.png',
              web_url: 'https://git.internal/alice',
              access_level: 30
            }
          ])
        ]
      ])
    )

    await expect(listLabels('/repo-root', 'upstream', 'conn-1')).resolves.toEqual([
      'bug',
      'feature'
    ])
    await expect(listAssignableUsers('/repo-root', 'upstream', 'conn-1')).resolves.toEqual([
      {
        id: 12,
        username: 'alice',
        name: 'Alice',
        avatarUrl: 'https://example.com/a.png',
        state: 'active'
      }
    ])

    expect(glabApiWithHeadersMock.mock.calls.map(([args]) => args)).toEqual([
      ['--hostname', 'git.internal', 'projects/stablyai%2Forca/labels?per_page=100&page=1'],
      ['--hostname', 'git.internal', 'projects/stablyai%2Forca/labels?per_page=100&page=2'],
      ['--hostname', 'git.internal', 'projects/stablyai%2Forca/members/all?per_page=100&page=1']
    ])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('probes past a full label page when a proxy strips the pagination headers', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index, name: `l${index}` }))
    serveGlabApiPages(
      new Map([
        ['projects/stablyai%2Forca/labels?per_page=100&page=1', glabIncludeOutput({}, fullPage)],
        [
          'projects/stablyai%2Forca/labels?per_page=100&page=2',
          glabIncludeOutput({}, [{ id: 100, name: 'last' }])
        ]
      ])
    )

    const labels = await listLabels('/repo-root')

    expect(labels).toHaveLength(101)
    expect(labels.at(-1)).toBe('last')
    expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(2)
  })

  it('stops paging when x-next-page does not advance and returns no members on an error body', async () => {
    getIssueProjectRefMock
      .mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
      .mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    serveGlabApiPages(
      new Map([
        [
          'projects/stablyai%2Forca/labels?per_page=100&page=1',
          glabIncludeOutput({ 'X-Next-Page': '1' }, [{ id: 1, name: 'bug' }])
        ],
        [
          'projects/stablyai%2Forca/members/all?per_page=100&page=1',
          glabIncludeOutput({}, { message: '403 Forbidden' })
        ]
      ])
    )

    await expect(listLabels('/repo-root')).resolves.toEqual(['bug'])
    await expect(listAssignableUsers('/repo-root')).resolves.toEqual([])
    expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(2)
  })

  it('addIssueComment posts to /notes and maps the response', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 100,
        author: { username: 'alice', avatar_url: 'https://example.com/a.png' },
        body: 'Hello',
        created_at: '2026-05-05T10:00:00Z'
      })
    })

    const result = await addIssueComment('/repo-root', 5, 'Hello')
    expect(result).toEqual({
      ok: true,
      comment: {
        id: 100,
        author: 'alice',
        authorAvatarUrl: 'https://example.com/a.png',
        body: 'Hello',
        createdAt: '2026-05-05T10:00:00Z',
        url: '',
        isBot: false
      }
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'POST', 'projects/stablyai%2Forca/issues/5/notes', '-f', 'body=Hello'],
      { cwd: '/repo-root' }
    )
  })

  it('addIssueComment passes hostname for SSH-backed self-hosted repos', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({
      host: 'gitlab.example.com',
      path: 'stablyai/orca'
    })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 100, body: 'Hello' })
    })

    await addIssueComment('/repo-root', 5, 'Hello', undefined, 'conn-1')

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'gitlab.example.com',
        '-X',
        'POST',
        'projects/stablyai%2Forca/issues/5/notes',
        '-f',
        'body=Hello'
      ],
      {}
    )
  })

  it('returns null from getIssue when project ref cannot be resolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)
    // An unresolved project returns null without invoking cwd-dependent glab.
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not a glab repo'))

    await expect(getIssue('/repo-root', 1)).resolves.toBeNull()
  })

  it('updateIssue returns error when project ref cannot be resolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)
    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toEqual({
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    })
  })
})
