import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { PageFaultBoundary } from './page-fault-boundary'

const FAILURE = new Error('the route threw')

function Throws(): ReactElement {
  throw FAILURE
}

function Renders(): ReactElement {
  return createElement('div', null, 'a worktree list')
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
  it('reports a throw from the tree it wraps and leaves nothing on the page', async () => {
    const faults: unknown[] = []
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(boundary(Throws, (error) => faults.push(error)))
    })
    expect(faults).toEqual([FAILURE])
    expect(rendered.tree?.toJSON()).toBeNull()
  })

  it('stays out of the way of a tree that renders', async () => {
    const faults: unknown[] = []
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(boundary(Renders, (error) => faults.push(error)))
    })
    expect(faults).toEqual([])
    expect(rendered.tree?.toJSON()).not.toBeNull()
  })

  it('reports once, because a faulted page never renders the tree that threw again', async () => {
    const faults: unknown[] = []
    const render = (): ReactElement => boundary(Throws, (error) => faults.push(error))
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(render())
    })
    await act(async () => {
      rendered.tree?.update(render())
    })
    expect(faults).toEqual([FAILURE])
  })

  it('carries the throw across a real bridge to the shell that mounted the page', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    await act(async () => {
      create(
        boundary(Throws, (error) => {
          pair.client.notifyPageFault(error)
        })
      )
    })
    await pair.flush()
    expect(pair.pageFaults).toEqual([
      { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    ])
  })
})
