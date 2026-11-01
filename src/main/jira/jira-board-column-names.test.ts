import { expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { getProjectStatusOrder } from './jira-transition-queries'

const { getClients, jiraRequest } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn()
}))
vi.mock('./client', () => ({ getClients, clearToken: vi.fn(), isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({
  jiraRequest,
  apiBasePath: () => '/rest/api/3',
  JiraApiError: class extends Error {}
}))
vi.mock('./request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))

it('retains configured column names and empty board columns', async () => {
  const site: JiraClientForSite = {
    site: {
      id: 'site-1',
      siteUrl: 'https://jira.invalid',
      email: '',
      displayName: 'Board fixture',
      accountId: 'fixture'
    },
    authorization: 'fixture'
  }
  getClients.mockReturnValue([site])
  jiraRequest.mockResolvedValueOnce({ total: 1, values: [{ id: 42 }] }).mockResolvedValueOnce({
    columnConfig: {
      columns: [
        { name: 'Ready', statuses: [{ id: '1' }] },
        { name: 'Doing', statuses: [] },
        { name: 'Complete', statuses: [{ id: '3' }] }
      ]
    }
  })
  await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
    statusIdsByColumn: [['1'], ['3']],
    columns: [
      { name: 'Ready', statusIds: ['1'] },
      { name: 'Doing', statusIds: [] },
      { name: 'Complete', statusIds: ['3'] }
    ]
  })
})
