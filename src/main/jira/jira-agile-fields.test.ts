import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { getAgileFieldIds, pickAgileFieldIds } from './jira-agile-fields'
import { mapJiraIssue, mapSprint } from './jira-issue-mapping'
import type { JiraSite } from '../../shared/jira-types'

const { jiraRequestMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  jiraRequestMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

const site: JiraSite = {
  id: 'site',
  siteUrl: 'https://example.atlassian.net',
  email: 'dev@example.com',
  displayName: 'Site',
  accountId: 'acc-1',
  authType: 'cloud'
}

function clientFor(id: string): JiraClientForSite {
  return { site: { ...site, id }, authorization: 'Basic token' }
}

describe('jira agile fields', () => {
  it('picks sprint and story point custom field ids from the field catalog', () => {
    expect(
      pickAgileFieldIds([
        {
          id: 'customfield_1',
          name: 'Sprint',
          schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
        },
        {
          id: 'customfield_2',
          name: 'Budget',
          schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
        },
        {
          id: 'customfield_3',
          name: 'Story Points',
          schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
        }
      ])
    ).toEqual({ sprint: 'customfield_1', storyPoints: 'customfield_3' })
  })

  it('prefers the active sprint and parses Server sprint strings', () => {
    expect(
      mapSprint([
        { name: 'Sprint 1', state: 'closed' },
        { name: 'Sprint 2', state: 'active' },
        { name: 'Sprint 3', state: 'future' }
      ])
    ).toBe('Sprint 2')
    // Server orders sprints by id, so the active one can sit between closed ones.
    expect(
      mapSprint([
        'com.atlassian.greenhopper.service.sprint.Sprint@1[id=3,state=CLOSED,name=Sprint 3,goal=]',
        'com.atlassian.greenhopper.service.sprint.Sprint@2[id=4,state=ACTIVE,name=Sprint 4,goal=]',
        'com.atlassian.greenhopper.service.sprint.Sprint@3[id=5,state=CLOSED,name=Sprint 5,goal=]'
      ])
    ).toBe('Sprint 4')
    expect(mapSprint(null)).toBeUndefined()
  })

  describe('getAgileFieldIds', () => {
    beforeEach(() => {
      jiraRequestMock.mockReset()
      acquireMock.mockClear()
      releaseMock.mockClear()
    })

    it('requests the field catalog once per site inside the request queue', async () => {
      jiraRequestMock.mockResolvedValue([
        {
          id: 'customfield_7',
          name: 'Sprint',
          schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
        }
      ])
      const client = clientFor('cached-site')
      const first = await getAgileFieldIds(client)
      const second = await getAgileFieldIds(client)
      expect(first).toEqual({ sprint: 'customfield_7' })
      expect(second).toBe(first)
      expect(jiraRequestMock).toHaveBeenCalledTimes(1)
      expect(jiraRequestMock.mock.calls[0]?.[1]).toBe('/rest/api/3/field')
      expect(acquireMock).toHaveBeenCalledTimes(1)
      expect(releaseMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to no agile fields and retries after a failed discovery', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      jiraRequestMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([])
      const client = clientFor('flaky-site')
      expect(await getAgileFieldIds(client)).toEqual({})
      expect(await getAgileFieldIds(client)).toEqual({})
      expect(jiraRequestMock).toHaveBeenCalledTimes(2)
      expect(releaseMock).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })
  })

  it('maps parent, estimates and agile custom fields onto the issue', () => {
    const issue = mapJiraIssue(
      site,
      {
        id: '1',
        key: 'ALP-1',
        fields: {
          summary: 'Story',
          parent: { key: 'ALP-9', fields: { summary: 'Big epic', issuetype: { name: 'Epic' } } },
          timeoriginalestimate: 7200,
          timeestimate: 3600,
          customfield_1: [{ name: 'Sprint 2', state: 'active' }],
          customfield_3: 5
        }
      },
      undefined,
      { sprint: 'customfield_1', storyPoints: 'customfield_3' }
    )
    expect(issue.parent).toEqual({ key: 'ALP-9', title: 'Big epic', issueTypeName: 'Epic' })
    expect(issue.originalEstimateSeconds).toBe(7200)
    expect(issue.remainingEstimateSeconds).toBe(3600)
    expect(issue.sprint).toBe('Sprint 2')
    expect(issue.storyPoints).toBe(5)
  })
})
