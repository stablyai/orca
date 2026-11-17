import { afterEach, expect, it, vi } from 'vitest'

import { printListingResult } from './listing-result-output'

afterEach(() => {
  vi.restoreAllMocks()
})

it('drops null listing keys but keeps the nulls whose absence means something else', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  printListingResult(
    {
      id: 'req-ps',
      ok: true,
      result: {
        worktrees: [
          {
            linkedPR: null,
            address: null,
            addressUnavailable: 'one-off-connection',
            workspaceLineage: null,
            crossStoreLineage: null,
            childWorktreeIds: [],
            agents: [{ toolName: null, agentWait: null }]
          }
        ]
      },
      _meta: { runtimeId: 'runtime-1' }
    },
    true,
    () => 'unused'
  )

  expect(logSpy).toHaveBeenCalledWith(
    '{"id":"req-ps","ok":true,"result":{"worktrees":[{"address":null,"addressUnavailable":"one-off-connection","workspaceLineage":null,"crossStoreLineage":null,"childWorktreeIds":[],"agents":[{"agentWait":null}]}]},"_meta":{"runtimeId":"runtime-1"}}'
  )
})
