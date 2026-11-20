import { describe, expect, it } from 'vitest'
import { withDefaultScopeServer } from './runtime-rpc-mobile-tracker-methods'

const runtime = { getClientDefaultScopeHost: () => 'runtime:server-1' as const }
const notReady = { relayReady: async () => false }

describe('phone tracker routing', () => {
  it('keeps Linear account setup on the default server even when its relay is not ready', async () => {
    for (const method of ['linear.connect', 'linear.selectWorkspace']) {
      expect(await withDefaultScopeServer({ method }, runtime, notReady)).toEqual({
        method,
        executionHost: 'runtime:server-1'
      })
    }
  })

  it('still answers other tracker calls, status included, on this desktop when the relay is not ready', async () => {
    for (const method of ['linear.listIssues', 'linear.status']) {
      expect(await withDefaultScopeServer({ method }, runtime, notReady)).toEqual({ method })
    }
  })
})
