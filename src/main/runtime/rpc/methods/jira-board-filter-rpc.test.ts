import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { JIRA_METHODS } from './jira'

it('keeps verified reads and combined board filters in separate public argument positions', async () => {
  const jiraListIssues = vi.fn().mockResolvedValue([])
  const stub = { getRuntimeId: () => 'board-runtime', jiraListIssues }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test dispatches only the fixture's Jira list method.
    runtime: stub as unknown as OrcaRuntimeService,
    methods: JIRA_METHODS
  })
  const filters = { statuses: ['Blocked', 'In Progress'], currentSprint: true }
  const response = await dispatcher.dispatch({
    id: 'board-filter',
    authToken: 'fixture',
    method: 'jira.listIssues',
    params: { filter: 'all', limit: 20, siteId: 'site-a', strict: true, filters }
  })
  expect(response).toMatchObject({ ok: true, result: [] })
  expect(jiraListIssues).toHaveBeenCalledWith('all', 20, 'site-a', true, filters)

  await dispatcher.dispatch({
    id: 'legacy-list',
    authToken: 'fixture',
    method: 'jira.listIssues',
    params: { filter: 'all', limit: 20, siteId: 'site-a' }
  })
  expect(jiraListIssues).toHaveBeenLastCalledWith('all', 20, 'site-a', undefined, undefined)
})
