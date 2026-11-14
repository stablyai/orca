import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { PageFaultBoundary } from './page-fault-boundary'

const FAILURE = new Error('the route threw')

function Throws(): ReactElement {
  throw FAILURE
}

function boundary(child: () => ReactElement, onFault: (error: unknown) => void): ReactElement {
  return createElement(PageFaultBoundary, { onFault }, createElement(child))
}

let logged: MockInstance<typeof console.error>

beforeEach(() => {
  // React prints the throw it handed to the boundary; the test is about what the page did with it.
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  logged.mockRestore()
})

describe('the page fault boundary', () => {
  it('reports a thrown route once across the bridge, including subsequent renders', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const render = (): ReactElement =>
      boundary(Throws, (error) => {
        pair.client.notifyPageFault(error)
      })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(render())
    })
    await act(async () => {
      rendered.tree?.update(render())
    })
    await pair.flush()
    expect(pair.pageFaults).toEqual([
      { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    ])
  })
})
