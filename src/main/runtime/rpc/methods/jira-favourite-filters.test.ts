import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { JIRA_METHODS } from './jira'

function fixture() {
  const result = {
    filters: [{ id: '1', name: 'Mine', jql: 'assignee = currentUser()', siteId: 'site-1' }],
    truncated: false
  }
  const jiraListFavouriteFilters = vi.fn().mockResolvedValue(result)
  const stub = { getRuntimeId: () => 'jira-runtime', jiraListFavouriteFilters }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture dispatches only the implemented Jira favourite filter method.
    runtime: stub as unknown as OrcaRuntimeService,
    methods: JIRA_METHODS
  })
  return { dispatcher, jiraListFavouriteFilters, result }
}

it.each([undefined, {}, { siteId: 'all' }, { siteId: '' }, { siteId: 'x'.repeat(129) }])(
  'rejects ambiguous sites through RPC: %j',
  async (params) => {
    const { dispatcher, jiraListFavouriteFilters } = fixture()
    const response = await dispatcher.dispatch({
      id: 'filters',
      authToken: 'fixture',
      method: 'jira.listFavouriteFilters',
      params
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(jiraListFavouriteFilters).not.toHaveBeenCalled()
  }
)
