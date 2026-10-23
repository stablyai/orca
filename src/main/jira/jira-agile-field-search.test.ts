import { describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { searchIssues } from './jira-issue-search'
import { getIssue } from './jira-issue-read'

const { getClientsMock, jiraRequestMock } = vi.hoisted(() => ({
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClientsMock(...args),
  clearToken: vi.fn(),
  isAuthError: () => false
}))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

function client(id: string): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: `https://${id}.atlassian.net`,
      email: '',
      displayName: id,
      accountId: 'viewer'
    },
    authorization: 'Basic fixture'
  }
}

describe('planning fields in Jira searches', () => {
  it('requests all discovered points fields and maps the populated project field', async () => {
    getClientsMock.mockReturnValue([client('field-request-site')])
    jiraRequestMock.mockImplementation(async (_entry, path) =>
      path.endsWith('/field')
        ? [
            {
              id: 'customfield_7',
              name: 'Sprint',
              schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
            },
            {
              id: 'customfield_8',
              name: 'Story Points',
              schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
            },
            {
              id: 'customfield_9',
              name: 'Story point estimate',
              schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' }
            }
          ]
        : {
            issues: [
              {
                id: '1',
                key: 'DEMO-1',
                fields: {
                  summary: 'Planning',
                  customfield_7: [{ name: 'Sprint 2', state: 'active' }],
                  customfield_8: null,
                  customfield_9: 0,
                  timeoriginalestimate: 3600,
                  timeestimate: 0,
                  parent: { key: 'DEMO-10', fields: { summary: 'Epic' } }
                }
              }
            ]
          }
    )
    const issues = await searchIssues('project = DEMO', 30, 'field-request-site')
    expect(issues[0]).toMatchObject({
      sprint: 'Sprint 2',
      storyPoints: 0,
      originalEstimateSeconds: 3600,
      remainingEstimateSeconds: 0,
      parent: { key: 'DEMO-10', title: 'Epic' }
    })
    const init = jiraRequestMock.mock.calls.find((call) => call[1].endsWith('/search/jql'))?.[2]
    expect(JSON.parse(init.body).fields).toEqual(
      expect.arrayContaining([
        'parent',
        'timeoriginalestimate',
        'timeestimate',
        'customfield_7',
        'customfield_8',
        'customfield_9'
      ])
    )
  })

  it('does not deadlock when more sites than queue slots discover fields together', async () => {
    const clients = Array.from({ length: 6 }, (_, index) => client(`queue-site-${index}`))
    getClientsMock.mockReturnValue(clients)
    jiraRequestMock
      .mockClear()
      .mockImplementation(async (_entry, path) =>
        path.endsWith('/field')
          ? []
          : { issues: [{ key: 'DEMO-1', fields: { summary: 'Planning' } }] }
      )
    expect(await searchIssues('project = DEMO', 30, 'all')).toHaveLength(6)
    expect(jiraRequestMock).toHaveBeenCalledTimes(12)
  })

  it.each(['search', 'detail'] as const)(
    'keeps ordinary Server %s reads available when optional discovery hangs',
    async (kind) => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const entry = client(`hung-${kind}`)
        entry.site.authType = 'server'
        getClientsMock.mockReturnValue([entry])
        jiraRequestMock
          .mockClear()
          .mockImplementation((_entry, path) =>
            path.endsWith('/field')
              ? new Promise(() => {})
              : Promise.resolve(
                  path.includes('/search')
                    ? { issues: [{ key: 'DEMO-1', fields: { summary: 'Still available' } }] }
                    : { key: 'DEMO-1', fields: { summary: 'Still available' } }
                )
          )
        const read = () =>
          kind === 'search'
            ? searchIssues('project = DEMO', 30, entry.site.id)
            : getIssue('DEMO-1', entry.site.id)
        const first = read()
        await vi.advanceTimersByTimeAsync(500)
        expect(await first).toMatchObject(
          kind === 'search' ? [{ title: 'Still available' }] : { title: 'Still available' }
        )
        expect(jiraRequestMock.mock.calls[0][2].signal.aborted).toBe(true)
        const before = jiraRequestMock.mock.calls.length
        await read()
        expect(jiraRequestMock.mock.calls.length).toBe(before + 1)
        expect(
          jiraRequestMock.mock.calls.filter((call) => call[1].endsWith('/field'))
        ).toHaveLength(1)
      } finally {
        warn.mockRestore()
        vi.useRealTimers()
      }
    }
  )

  it('preserves planning fields when a list issue is hydrated from its detail read', async () => {
    getClientsMock.mockReturnValue([client('detail-field-site')])
    jiraRequestMock.mockClear().mockImplementation(async (_entry, path) =>
      path.endsWith('/field')
        ? [
            {
              id: 'customfield_4',
              name: 'Sprint',
              schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
            },
            {
              id: 'customfield_5',
              name: 'Points',
              schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' }
            }
          ]
        : {
            id: '1',
            key: 'DEMO-1',
            fields: {
              summary: 'Planning',
              description: 'Detailed planning notes',
              customfield_4: [{ name: 'Sprint 3', state: 'active' }],
              customfield_5: 0,
              timeoriginalestimate: 7200,
              timeestimate: 0,
              parent: { key: 'DEMO-10', fields: { summary: 'Epic' } }
            }
          }
    )
    expect(await getIssue('DEMO-1', 'detail-field-site')).toMatchObject({
      description: 'Detailed planning notes',
      sprint: 'Sprint 3',
      storyPoints: 0,
      originalEstimateSeconds: 7200,
      remainingEstimateSeconds: 0,
      parent: { key: 'DEMO-10', title: 'Epic' }
    })
    const detailPath = jiraRequestMock.mock.calls.find((call) => call[1].includes('/issue/'))?.[1]
    const fields = new URL(detailPath, 'https://example.atlassian.net').searchParams.get('fields')
    expect(fields?.split(',')).toEqual(
      expect.arrayContaining(['description', 'customfield_4', 'customfield_5'])
    )
  })
})
