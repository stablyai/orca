import { createElement, type ReactElement } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createOrcaQueryClient } from '../../query/orca-query-client'

// One query client per mounted document: `leave` keeps its cache for a return, `unmount` ends the document.
export function documentQueryClient() {
  let queryClient: QueryClient | undefined
  return {
    wrap(element: ReactElement): ReactElement {
      queryClient ??= createOrcaQueryClient()
      return createElement(QueryClientProvider, { client: queryClient }, element)
    },
    // The recorder refuses leftover timers: a cancelled fetch schedules gc as it settles, and clear() drops them.
    async end(): Promise<void> {
      const ended = queryClient
      queryClient = undefined
      await ended?.cancelQueries()
      ended?.clear()
    }
  }
}

// For tests outside the recorder: TanStack tells observers on a zero-delay timer it schedules once a reply's promise chain settles.
export async function settleQueryNotifications(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export function hookMount(render: () => void) {
  let renderer: ReactTestRenderer | undefined
  const queries = documentQueryClient()
  function Harness() {
    render()
    return null
  }
  return {
    mount() {
      act(() => {
        renderer = create(queries.wrap(createElement(Harness)))
      })
    },
    update() {
      act(() => {
        renderer?.update(queries.wrap(createElement(Harness)))
      })
    },
    leave() {
      act(() => {
        renderer?.unmount()
        renderer = undefined
      })
    },
    unmount(): Promise<void> {
      act(() => {
        renderer?.unmount()
        renderer = undefined
      })
      // After act: unmount cleanups run as it exits and schedule gc timers.
      return queries.end()
    }
  }
}

export function performHookAction<T>(action: () => T): T {
  let result!: T
  act(() => {
    result = action()
  })
  return result
}
