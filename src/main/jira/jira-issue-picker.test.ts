import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { JiraApiError } from './jira-api-error'
import { searchIssues } from './jira-issue-search'

const { getClients, jiraRequest, acquire, release, clearToken } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  clearToken: vi.fn()
}))
vi.mock('./client', () => ({
  getClients,
  clearToken,
  isAuthError: (error: { status?: number }) => error.status === 401
}))
vi.mock('./authenticated-request', () => ({
  jiraRequest,
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3'
}))
vi.mock('./request-queue', () => ({ acquire, release }))
vi.mock('./jira-agile-fields', () => ({
  getAgileFieldIds: async () => ({}),
  agileFieldIdList: () => []
}))

function entry(id = 'cloud', server = false): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: `https://${id}.example.com`,
      email: '',
      displayName: id,
      accountId: 'test',
      ...(server ? { authType: 'server' as const } : {})
    },
    authorization: 'test-only'
  }
}
function issue(key: string) {
  return { key, fields: { summary: `Issue ${key}`, updated: '2026-01-01T00:00:00Z' } }
}
const fallback = 'text ~ "1799*" ORDER BY updated DESC'
const suggestions = { query: '1799', currentJql: 'ORDER BY updated DESC' }

beforeEach(() => {
  vi.resetAllMocks()
  getClients.mockReturnValue([entry()])
})

describe('numeric Jira issue suggestions', () => {
  it('hydrates exact suffixes once under the original scope and one queue slot', async () => {
    const currentJql = 'status = Open AND sprint in openSprints() ORDER BY updated DESC'
    jiraRequest
      .mockResolvedValueOnce({
        sections: [
          { issues: [{ key: 'ALP-1799' }, { key: 'ALP-21799' }, { key: 'invalid"-1799' }] },
          { issues: [{ key: 'ALP-1799' }, { key: 'BETA-1799' }] }
        ]
      })
      .mockResolvedValueOnce({ issues: [issue('BETA-1799')] })
    const result = await searchIssues(fallback, 30, 'cloud', undefined, false, {
      ...suggestions,
      currentJql
    })
    expect(result.map(({ key, siteId }) => ({ key, siteId }))).toEqual([
      { key: 'BETA-1799', siteId: 'cloud' }
    ])
    const picker = new URL(jiraRequest.mock.calls[0][1], 'https://example.com')
    expect(picker.pathname).toBe('/rest/api/3/issue/picker')
    expect(picker.searchParams.get('query')).toBe('1799')
    expect(picker.searchParams.get('currentJQL')).toBe(currentJql)
    expect(picker.searchParams.get('showSubTasks')).toBe('true')
    expect(JSON.parse(jiraRequest.mock.calls[1][2].body).jql).toBe(
      '(status = Open AND sprint in openSprints()) AND key in ("ALP-1799", "BETA-1799") ORDER BY updated DESC'
    )
    expect(jiraRequest).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('hydrates matching keys on their own site and uses the Data Center API paths', async () => {
    getClients.mockReturnValue([entry('cloud'), entry('dc', true)])
    jiraRequest.mockImplementation(async (_client: JiraClientForSite, path: string) => {
      if (path.includes('/issue/picker?')) {
        return { sections: [{ issues: [{ key: 'ALP-1799' }] }] }
      }
      return { issues: [issue('ALP-1799')] }
    })
    const result = await searchIssues(fallback, 30, 'all', undefined, false, suggestions)
    expect(result.map(({ siteId }) => siteId).sort()).toEqual(['cloud', 'dc'])
    expect(
      jiraRequest.mock.calls.map(([client, path]) => [client.site.id, path.split('?')[0]])
    ).toEqual([
      ['cloud', '/rest/api/3/issue/picker'],
      ['dc', '/rest/api/2/issue/picker'],
      ['cloud', '/rest/api/3/search/jql'],
      ['dc', '/rest/api/2/search']
    ])
  })

  it('keeps current-scope candidates after history fills the display limit', async () => {
    jiraRequest
      .mockResolvedValueOnce({
        sections: [
          { issues: [{ key: 'A-1799' }, { key: 'B-1799' }] },
          { issues: [{ key: 'C-1799' }] }
        ]
      })
      .mockResolvedValueOnce({ issues: [issue('C-1799')] })
    const result = await searchIssues(fallback, 2, 'cloud', undefined, false, {
      ...suggestions,
      currentJql: 'sprint in openSprints() ORDER BY updated DESC'
    })
    expect(result.map(({ key }) => key)).toEqual(['C-1799'])
    expect(JSON.parse(jiraRequest.mock.calls[1][2].body)).toMatchObject({
      jql: '(sprint in openSprints()) AND key in ("A-1799", "B-1799", "C-1799") ORDER BY updated DESC',
      maxResults: 2
    })
  })

  it.each([
    [12, 'TEXT-10'],
    [50, 'TEXT-48']
  ] as const)(
    'keeps exact keys ahead of newer text matches across sites (limit %i)',
    async (limit, lastTextKey) => {
      getClients.mockReturnValue([entry('cloud'), entry('dc', true)])
      const exact = ['A-1799', 'B-1799'].map((key, index) => ({
        ...issue(key),
        fields: { summary: key, updated: `2025-01-0${index + 1}T00:00:00Z` }
      }))
      const text = Array.from({ length: limit }, (_, index) => issue(`TEXT-${index + 1}`))
      jiraRequest.mockImplementation(async (client: JiraClientForSite, path: string) => {
        if (path.includes('/issue/picker?')) {
          return { sections: [{ issues: client.site.id === 'cloud' ? exact : [] }] }
        }
        return { issues: client.site.id === 'cloud' ? exact : text }
      })

      const result = await searchIssues(fallback, limit, 'all', undefined, false, suggestions)

      expect(result).toHaveLength(limit)
      expect(result.slice(0, 3).map(({ key }) => key)).toEqual(['B-1799', 'A-1799', 'TEXT-1'])
      expect(result.at(-1)?.key).toBe(lastTextKey)
    }
  )

  it('rejects candidate overflow rather than silently omitting matches', async () => {
    jiraRequest
      .mockResolvedValueOnce({
        sections: [
          { issues: Array.from({ length: 101 }, (_, index) => ({ key: `P${index}-1799` })) }
        ]
      })
      .mockResolvedValueOnce({ issues: [] })
    await expect(searchIssues(fallback, 2, 'cloud', undefined, false, suggestions)).rejects.toThrow(
      'candidate limit'
    )
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it.each([{ sections: [] }, { sections: [{ issues: [{ key: 'A-11799' }] }] }])(
    'falls back once when no keys match: %j',
    async (response) => {
      jiraRequest.mockResolvedValueOnce(response).mockResolvedValueOnce({ issues: [issue('A-50')] })
      const result = await searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
      expect(result[0].key).toBe('A-50')
      expect(JSON.parse(jiraRequest.mock.calls[1][2].body).jql).toBe(fallback)
      expect(jiraRequest).toHaveBeenCalledTimes(2)
    }
  )

  it('falls back to scoped text when picker history keys are outside the current sprint', async () => {
    const scopedText = '(text ~ "1799*") AND sprint in openSprints()'
    jiraRequest
      .mockResolvedValueOnce({ sections: [{ issues: [{ key: 'A-1799' }] }] })
      .mockResolvedValueOnce({ issues: [] })
      .mockResolvedValueOnce({ issues: [issue('B-20')] })

    const result = await searchIssues(scopedText, 30, 'cloud', undefined, false, {
      ...suggestions,
      currentJql: 'sprint in openSprints() ORDER BY updated DESC'
    })

    expect(result.map(({ key }) => key)).toEqual(['B-20'])
    expect(JSON.parse(jiraRequest.mock.calls[2][2].body).jql).toBe(scopedText)
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it.each([401, 403, 429, 500])('surfaces HTTP %i without text fallback', async (status) => {
    jiraRequest.mockRejectedValueOnce(new JiraApiError('request failed', status))
    await expect(
      searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
    ).rejects.toThrow(`Error ${status}:`)
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(clearToken).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each([null, {}, { sections: [{}] }, { sections: [{ issues: [{}] }] }])(
    'rejects malformed picker data: %j',
    async (response) => {
      jiraRequest.mockResolvedValueOnce(response)
      await expect(
        searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
      ).rejects.toThrow('invalid issue suggestions')
      expect(jiraRequest).toHaveBeenCalledTimes(1)
    }
  )

  it('aborts an in-flight picker without hydration, fallback or token clearing', async () => {
    const controller = new AbortController()
    jiraRequest.mockImplementationOnce(async (_client, _path, init: RequestInit) => {
      controller.abort()
      init.signal?.throwIfAborted()
    })
    await expect(
      searchIssues(fallback, 30, 'cloud', controller.signal, false, suggestions)
    ).rejects.toThrow()
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(clearToken).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized hydration queries before sending them', async () => {
    jiraRequest.mockResolvedValueOnce({
      sections: [{ issues: [{ key: `${'A'.repeat(8192)}-1799` }] }]
    })
    await expect(
      searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
    ).rejects.toThrow('length limit')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('bounds multibyte scope plus candidate keys by UTF-8 bytes', async () => {
    jiraRequest
      .mockResolvedValueOnce({ sections: [{ issues: [{ key: 'A-1799' }] }] })
      .mockResolvedValueOnce({ issues: [] })
    await expect(
      searchIssues(fallback, 30, 'cloud', undefined, false, {
        ...suggestions,
        currentJql: `summary ~ "${'汉'.repeat(2725)}"`
      })
    ).rejects.toThrow('length limit')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it.each([{}, null, { issues: {} }])(
    'rejects malformed hydrated details: %j',
    async (response) => {
      jiraRequest
        .mockResolvedValueOnce({ sections: [{ issues: [{ key: 'A-1799' }] }] })
        .mockResolvedValueOnce(response)
      await expect(
        searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
      ).rejects.toThrow('invalid issue page')
      expect(jiraRequest).toHaveBeenCalledTimes(2)
    }
  )

  it('does not turn a hydration failure into a text search', async () => {
    jiraRequest
      .mockResolvedValueOnce({ sections: [{ issues: [{ key: 'A-1799' }] }] })
      .mockRejectedValueOnce(new JiraApiError('read failed', 503))
    await expect(
      searchIssues(fallback, 30, 'cloud', undefined, false, suggestions)
    ).rejects.toThrow('Error 503:')
    expect(jiraRequest).toHaveBeenCalledTimes(2)
  })

  it('ignores nonnumeric suggestion hints', async () => {
    jiraRequest.mockResolvedValueOnce({ issues: [issue('ALP-20')] })
    const result = await searchIssues(fallback, 30, 'cloud', undefined, false, {
      ...suggestions,
      query: 'text'
    })
    expect(result[0].key).toBe('ALP-20')
    expect(jiraRequest.mock.calls[0][1]).toBe('/rest/api/3/search/jql')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy JQL path without numeric suggestions', async () => {
    jiraRequest.mockResolvedValue({ issues: [issue('ALP-20')] })
    const result = await searchIssues('project = ALP', 30, 'cloud')
    expect(result[0].key).toBe('ALP-20')
    expect(jiraRequest.mock.calls[0][1]).toBe('/rest/api/3/search/jql')
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })
})
