import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { withDefaultScopeServer } from './runtime-rpc-mobile-tracker-methods'

const server: ExecutionHostId = 'runtime:server-a'
const runtime = { getClientDefaultScopeHost: () => server }
const relayDown = { relayReady: async () => false }

describe('withDefaultScopeServer', () => {
  // A typed token must reach the default server or fail; it may never be stored on this desktop instead.
  it.each(['jira.connect', 'linear.connect', 'linear.selectWorkspace'])(
    'pins %s to the default server even when its relay is down',
    async (method) => {
      await expect(withDefaultScopeServer({ method }, runtime, relayDown)).resolves.toEqual({
        method,
        executionHost: server
      })
    }
  )

  it('lets reads fall back to this desktop when the relay is down', async () => {
    await expect(
      withDefaultScopeServer({ method: 'jira.status' }, runtime, relayDown)
    ).resolves.toEqual({ method: 'jira.status' })
  })
})
