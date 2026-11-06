import { createElement, useLayoutEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/structured-agent-session-surface-capabilities'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import {
  descriptorFor,
  rpcSuccess,
  settle
} from './use-mobile-structured-agent-options.test-fixture'

const SAVED: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: [
    { id: 'gpt-saved', label: 'GPT Saved', isDefault: true, efforts: [] },
    { id: 'gpt-other', label: 'GPT Other', isDefault: false, efforts: [] }
  ],
  fetchedAt: 1,
  listingNamesConfiguredModel: false
}

it('shows the host’s last model list when a chat reopens, before its own catalog read answers', async () => {
  // The chat's own reads never answer; only the saved-only preload does.
  const pending = () => new Promise<never>(() => {})
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) =>
      method === 'agentSession.modelCatalog' &&
      typeof params === 'object' &&
      params !== null &&
      'savedOnly' in params
        ? rpcSuccess(SAVED)
        : pending(),
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
  const queryClient = createOrcaQueryClient()
  let shown: ReturnType<typeof useMobileStructuredAgentOptions> | null = null
  function Chat(): null {
    const options = useMobileStructuredAgentOptions({
      agent: 'codex',
      hostId: 'host-1',
      client,
      sessionId: 'session-1',
      enabled: true,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate: async () => ({ status: 'rejected' }),
      hostSupport: { permissionModes: true, sendOptions: false, statusFeed: false }
    })
    useLayoutEffect(() => {
      shown = options
    })
    return null
  }
  const open = async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Chat))
      )
    })
    await settle()
    return renderer
  }
  const first = await open()
  await act(async () => first.unmount())

  const reopened = await open()
  expect(descriptorFor(shown!.optionSnapshot, 'model')?.kind).toEqual({
    type: 'select',
    choices: [
      { value: 'gpt-saved', label: 'GPT Saved' },
      { value: 'gpt-other', label: 'GPT Other' }
    ]
  })
  await act(async () => reopened.unmount())
})
