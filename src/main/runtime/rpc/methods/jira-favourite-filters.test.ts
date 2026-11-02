import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { JIRA_METHODS } from './jira'
import { RPC_PARAMS_BY_METHOD } from '../../../../shared/rpc-contract/rpc-params-catalog.generated'

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

it('routes a single site and cancellation signal to the execution runtime', async () => {
  const { dispatcher, jiraListFavouriteFilters, result } = fixture()
  const controller = new AbortController()
  const response = await dispatcher.dispatch(
    {
      id: 'filters',
      authToken: 'fixture',
      method: 'jira.listFavouriteFilters',
      params: { siteId: ' site-1 ' }
    },
    { signal: controller.signal }
  )
  expect(response).toMatchObject({ ok: true, result })
  expect(jiraListFavouriteFilters).toHaveBeenCalledExactlyOnceWith('site-1', controller.signal)
  expect(RPC_PARAMS_BY_METHOD['jira.listFavouriteFilters']).toBeDefined()
})

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
