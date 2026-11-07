import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/agent-session/options/structured-agent-session-seed-catalog'
import { createStructuredAgentSessionOptionState } from '../../../src/shared/agent-session/options/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'

const LISTED: AgentSessionModelCatalogResult = {
  origin: 'live-session',
  models: [{ id: 'running-account-model', label: 'Running', isDefault: true, efforts: [] }],
  fetchedAt: 1
}

function listingClient(): RpcClient {
  let plainReads = 0
  return {
    sendRequest: (_method: string, params?: unknown) => {
      const waits = typeof params === 'object' && params !== null && 'waitForListing' in params
      if (waits) {
        // The host's listing is still running for the whole test.
        return new Promise(() => {})
      }
      plainReads += 1
      const result = plainReads === 1 ? { origin: 'unknown', listingInProgress: true } : LISTED
      return Promise.resolve({ id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

describe('useMobileHostModelCatalogUpgrade', () => {
  it('does not save a read sent after the first turn, even while a pre-turn listing is waited on', async () => {
    const client = listingClient()
    const record = vi.fn()
    const activeOptionRecordRef = {
      current: createStructuredAgentSessionOptionState('opencode').record
    }
    function Probe(props: { hasTurn: boolean; selectedModel?: string }): null {
      useMobileHostModelCatalogUpgrade({
        agent: 'opencode',
        client,
        sessionId: 'session-1',
        enabled: true,
        newLaunch: true,
        worktree: 'wt-1',
        hasTurn: props.hasTurn,
        ...(props.selectedModel ? { selectedModel: props.selectedModel } : {}),
        fence: 1,
        optionCatalog: structuredAgentSessionSeedCatalog('opencode'),
        modelCatalogCache: { seed: () => undefined, record },
        receiveCatalog: () => {},
        activeOptionRecordRef,
        updateOptionState: () => {}
      })
      return null
    }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(Probe, { hasTurn: false }))
    })
    await act(async () => {
      renderer?.update(createElement(Probe, { hasTurn: true, selectedModel: 'other-model' }))
    })

    expect(record.mock.calls.map(([, catalog]) => catalog)).not.toContainEqual(LISTED)
    await act(async () => renderer?.unmount())
  })
})
