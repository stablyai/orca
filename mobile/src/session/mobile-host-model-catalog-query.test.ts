import { createElement, useLayoutEffect } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/structured-agent-session-surface-capabilities'
import { createWithQueryClient } from '../test-support/query-client-test-renderer'
import type { RpcClient } from '../transport/rpc-client'
import { recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import { useHostModelCatalogCache } from './mobile-host-model-catalog-query'
import type { HostModelCatalogCache } from './use-mobile-host-model-catalog-upgrade'

function listed(id: string): AgentSessionModelCatalogResult {
  return {
    origin: 'probe',
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    fetchedAt: 1,
    listingNamesConfiguredModel: false
  }
}

function heldPreloadClient() {
  let answer: (catalog: AgentSessionModelCatalogResult) => void = () => {}
  const client: RpcClient = {
    sendRequest: () =>
      new Promise((resolve) => {
        answer = (catalog) =>
          resolve({ id: 'r', ok: true, result: catalog, _meta: { runtimeId: 'runtime-1' } })
      }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  recordRuntimeStatusProbe(client, {
    capabilities: [AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY]
  })
  return { client, answer: (catalog: AgentSessionModelCatalogResult) => answer(catalog) }
}

async function mountCache(client: RpcClient) {
  const mounted: { cache: HostModelCatalogCache | null } = { cache: null }
  function Probe(): null {
    const current = useHostModelCatalogCache({
      hostId: 'host-1',
      client,
      agent: 'claude',
      enabled: true
    })
    useLayoutEffect(() => {
      mounted.cache = current
    })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = createWithQueryClient(createElement(Probe))
  })
  return { mounted, unmount: () => act(async () => renderer?.unmount()) }
}

describe('useHostModelCatalogCache', () => {
  it("keeps a new chat's answer that lands while an older preload is out", async () => {
    const host = heldPreloadClient()
    const { mounted, unmount } = await mountCache(host.client)

    await act(async () => mounted.cache?.record('wt-1', listed('opus')))
    await act(async () => host.answer(listed('sonnet')))

    expect(mounted.cache?.seed({ newLaunch: true, worktree: 'wt-1', seedsModel: false })).toEqual(
      listed('opus')
    )
    await unmount()
  })
})
