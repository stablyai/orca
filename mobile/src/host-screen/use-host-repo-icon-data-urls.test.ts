import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { ICON_RETRY_COOLDOWN_MS, useHostRepoIconDataUrls } from './use-host-repo-icon-data-urls'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}

function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

afterEach(() => {
  unmountRenderers()
  vi.useRealTimers()
})

describe('useHostRepoIconDataUrls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  function setup(onRequest: (ids: readonly string[]) => Promise<RpcResponse>): {
    current: () => ReadonlyMap<string, string | null>
    updateIds: (ids: readonly string[]) => void
    client: RpcClient
  } {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sendRequest satisfies client contract.
    const client = {
      sendRequest: vi.fn(async (_method: string, params: unknown) => {
        const { ids } = params as { ids: readonly string[] }
        return onRequest(ids)
      })
    } as unknown as RpcClient

    let result: ReadonlyMap<string, string | null> = new Map()
    let renderer: ReturnType<typeof createRenderer>

    function Probe({ ids }: { ids: readonly string[] }): null {
      result = useHostRepoIconDataUrls(client, ids)
      return null
    }

    act(() => {
      renderer = create(createElement(Probe, { ids: [] }))
    })

    return {
      current: () => result,
      updateIds: (ids: readonly string[]) => {
        act(() => {
          renderer.update(createElement(Probe, { ids }))
        })
      },
      client
    }
  }

  it('keeps failed IDs subject to the cooldown and does not retry on repeated feed updates within cooldown', async () => {
    let callCount = 0
    const harness = setup(async (ids) => {
      callCount++
      return {
        id: 'r',
        ok: true,
        result: {
          icons: ids.map((id) => ({ id, dataUrl: null }))
        },
        _meta: { runtimeId: 'test' }
      }
    })

    // First install: requests icon-1
    harness.updateIds(['icon-1'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(callCount).toBe(1)
    expect(harness.current().get('icon-1')).toBeNull()

    // Repeated feed update 5s later: should NOT re-request icon-1
    vi.advanceTimersByTime(5_000)
    harness.updateIds(['icon-1'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(callCount).toBe(1)

    // After cooldown passes (60s): should allow retry
    vi.advanceTimersByTime(ICON_RETRY_COOLDOWN_MS)
    harness.updateIds(['icon-1'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(callCount).toBe(2)
  })

  it('evicts tracking state alongside dataUrls when capacity exceeds 512', async () => {
    const harness = setup(async (ids) => ({
      id: 'r',
      ok: true,
      result: {
        icons: ids.map((id) => ({ id, dataUrl: `data:image/png;base64,${id}` }))
      },
      _meta: { runtimeId: 'test' }
    }))

    // Load 520 icons in chunks of 50
    for (let i = 0; i < 520; i += 50) {
      const batchIds = Array.from({ length: Math.min(50, 520 - i) }, (_, idx) => `icon-${i + idx}`)
      harness.updateIds(batchIds)
      await act(async () => {
        await Promise.resolve()
      })
    }

    // Capacity is capped at 512
    expect(harness.current().size).toBeLessThanOrEqual(512)
    // The earliest icon (icon-0) should have been evicted
    expect(harness.current().has('icon-0')).toBe(false)
  })
})
