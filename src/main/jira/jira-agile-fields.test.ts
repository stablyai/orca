import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { getAgileFieldIds } from './jira-agile-fields'
import { mapSprint } from './jira-issue-mapping'

import type { JiraSite } from '../../shared/jira/jira-types'

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
  it('keeps commas and brackets in Server sprint names', () => {
    expect(
      mapSprint('Sprint@1[id=1,state=ACTIVE,name=API, UI [October],startDate=<null>,goal=]')
    ).toBe('API, UI [October]')
    expect(mapSprint('Sprint@1[id=1,state=ACTIVE,name=API, UI [October]]')).toBe(
      'API, UI [October]'
    )
  })

  describe('getAgileFieldIds', () => {
    beforeEach(() => {
      jiraRequestMock.mockReset()
      acquireMock.mockClear()
      releaseMock.mockClear()
    })

    it('shares discovery without one cancelled caller abandoning another', async () => {
      const response = Promise.withResolvers<unknown[]>()
      jiraRequestMock.mockReturnValue(response.promise)
      const client = clientFor('concurrent-site')
      const controller = new AbortController()
      const first = getAgileFieldIds(client, controller.signal)
      const second = getAgileFieldIds(client)
      controller.abort()
      await expect(first).rejects.toThrow('aborted')
      response.resolve([
        { id: 'customfield_9', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }
      ])
      expect(await second).toEqual({ sprint: 'customfield_9' })
      expect(jiraRequestMock).toHaveBeenCalledTimes(1)
      expect(releaseMock).toHaveBeenCalledTimes(1)
    })
  })
})
