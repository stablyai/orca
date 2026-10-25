import { describe, expect, it } from 'vitest'
import { SIDEBAR_INPUTS_SEMANTICS_VERSION } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import type { InstalledSidebarInputs } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-installer'
import { installSidebarFeedSnapshot } from '../../../src/shared/sidebar-feed-client/sidebar-feed-snapshot'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { hostSidebarFeedTransport } from './host-sidebar-feed-operations'
import { readHostSidebarFeed } from './use-host-sidebar-feed'

function refused(code: string, message: string): RpcResponse {
  return { id: 'r', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime' } }
}

describe('hostSidebarFeedTransport', () => {
  it.each([
    ['method_not_found', 'unknown method'],
    ['forbidden', "Method 'sidebarInputs.read' is not available to mobile clients"]
  ])('reads a host without the feed (%s) as unavailable', async (code, message) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport calls only sendRequest.
    const client = {
      sendRequest: async () => refused(code, message)
    } as unknown as UnvalidatedRpcRequestPort
    expect(await hostSidebarFeedTransport(client)({ maxBytes: 1 })).toEqual({
      kind: 'unavailable'
    })
  })

  it('reads any other refusal as a failure to retry', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport calls only sendRequest.
    const client = {
      sendRequest: async () => refused('timeout', 'Request timed out')
    } as unknown as UnvalidatedRpcRequestPort
    expect(await hostSidebarFeedTransport(client)({ maxBytes: 1 })).toEqual({ kind: 'failed' })
  })
})

describe('readHostSidebarFeed', () => {
  const installed = (semanticsVersion: number): InstalledSidebarInputs => ({
    generation: 'g',
    revision: 3,
    schemaVersion: 1,
    semanticsVersion,
    domains: new Map()
  })
  const snapshot = (semanticsVersion = SIDEBAR_INPUTS_SEMANTICS_VERSION) =>
    installSidebarFeedSnapshot(installed(semanticsVersion), null)

  it('is loading until a batch installs, then exposes its domains', () => {
    expect(readHostSidebarFeed({ snapshot: null, unavailable: false })).toEqual({
      kind: 'loading'
    })
    const installed = snapshot()
    expect(readHostSidebarFeed({ snapshot: installed, unavailable: false })).toEqual({
      kind: 'ready',
      domains: installed.domains
    })
  })

  it('asks to reopen a host without the feed', () => {
    expect(readHostSidebarFeed({ snapshot: null, unavailable: true })).toEqual({ kind: 'reopen' })
  })

  it('asks to reopen when the host means other things by its inputs', () => {
    expect(
      readHostSidebarFeed({
        snapshot: snapshot(SIDEBAR_INPUTS_SEMANTICS_VERSION + 1),
        unavailable: false
      })
    ).toEqual({ kind: 'reopen' })
  })

  it('asks a host from before desktop facts carried focus and labels to reopen', () => {
    expect(readHostSidebarFeed({ snapshot: snapshot(1), unavailable: false })).toEqual({
      kind: 'reopen'
    })
  })
})
