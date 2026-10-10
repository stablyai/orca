import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

// The phone's half of a stopped chat reopened after its account's list aged: the host answers its
// options with the saved model while it re-lists, so the picker must read them again once that
// listing lands, showing what the next start runs before anything is sent.

const MODELS = [
  { id: 'opus', label: 'Opus', isDefault: true, efforts: [] },
  { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function hostClient(
  optionReads: readonly AgentSessionOptionsResult[],
  listing: Promise<AgentSessionModelCatalogResult>,
  /** The first catalog answer; absent, it says the listing is running. */
  firstCatalog?: Promise<AgentSessionModelCatalogResult>
) {
  let reads = 0
  let catalogReads = 0
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      let result: unknown = {}
      if (method === 'agentSession.options') {
        result = optionReads[Math.min(reads++, optionReads.length - 1)]
      } else if (method === 'agentSession.modelCatalog') {
        catalogReads += 1
        result =
          typeof params === 'object' && params !== null && 'waitForListing' in params
            ? await listing
            : firstCatalog
              ? await firstCatalog
              : { origin: 'probe', models: MODELS, fetchedAt: 1_000, listingInProgress: true }
      }
      return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, reads: () => reads, catalogReads: () => catalogReads }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

function Probe(props: {
  client: RpcClient
  mutate: StructuredAgentSessionMutate
  onRender: (controller: Controller) => void
}): null {
  props.onRender(
    useMobileStructuredAgentOptions({
      agent: 'claude',
      client: props.client,
      sessionId: 'stopped-chat',
      enabled: true,
      fence: 3,
      mutate: props.mutate
    })
  )
  return null
}

async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve()
    }
  })
}

describe('a stopped chat on the phone whose saved model the re-listing finds gone', () => {
  it('shows the replacement once the listing lands, with no send', async () => {
    const listed = deferred<AgentSessionModelCatalogResult>()
    const host = hostClient(
      [
        { models: MODELS, current: { model: 'gone' } },
        { models: MODELS, current: { model: 'opus' } }
      ],
      listed.promise
    )
    const mutate: StructuredAgentSessionMutate = vi.fn()
    const rendered: { current: Controller | null } = { current: null }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(Probe, {
          client: host.client,
          mutate,
          onRender: (controller) => {
            rendered.current = controller
          }
        })
      )
    })
    await settle()
    const shownModel = () => {
      const model = rendered.current?.optionSnapshot.find((entry) => entry.id === 'model')
      return model?.kind.type === 'select' ? model.kind.currentValue : undefined
    }
    expect(shownModel()).toBe('gone')

    await act(async () => {
      listed.resolve({
        origin: 'probe',
        models: MODELS,
        fetchedAt: 2_000,
        unlistedModelReplacement: 'opus'
      })
    })
    await settle()
    expect(shownModel()).toBe('opus')
    expect(host.reads()).toBe(2)
    expect(mutate).not.toHaveBeenCalled()
    await act(async () => renderer?.unmount())
  })

  it('reads the options once more when the catalog answer lands after the listing did', async () => {
    const late = deferred<AgentSessionModelCatalogResult>()
    const host = hostClient(
      [
        { models: MODELS, current: { model: 'gone' } },
        { models: MODELS, current: { model: 'opus' } }
      ],
      new Promise(() => {}),
      late.promise
    )
    const mutate: StructuredAgentSessionMutate = vi.fn()
    const rendered: { current: Controller | null } = { current: null }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(Probe, {
          client: host.client,
          mutate,
          onRender: (controller) => {
            rendered.current = controller
          }
        })
      )
    })
    await settle()
    const shownModel = () => {
      const model = rendered.current?.optionSnapshot.find((entry) => entry.id === 'model')
      return model?.kind.type === 'select' ? model.kind.currentValue : undefined
    }
    expect(shownModel()).toBe('gone')

    await act(async () => {
      late.resolve({
        origin: 'probe',
        models: MODELS,
        fetchedAt: 2_000,
        unlistedModelReplacement: 'opus'
      })
    })
    await settle()
    await settle()
    expect(shownModel()).toBe('opus')
    // One re-read, and the current answer it brings starts no other.
    expect(host.reads()).toBe(2)
    expect(host.catalogReads()).toBe(1)
    expect(mutate).not.toHaveBeenCalled()
    await act(async () => renderer?.unmount())
  })
})
