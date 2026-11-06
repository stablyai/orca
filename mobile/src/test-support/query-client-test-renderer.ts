import { createElement, type ReactElement } from 'react'
import { QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { create, type ReactTestRenderer, type TestRendererOptions } from 'react-test-renderer'
import { createOrcaQueryClient } from '../query/orca-query-client'

// TanStack tells observers on a zero-delay timer; a microtask lets act() and fake-timer tests see replies.
notifyManager.setScheduler(queueMicrotask)

/** react-test-renderer's create inside a query client that lives as long as the renderer, as a page document's does. */
export function createWithQueryClient(
  element: ReactElement,
  options?: TestRendererOptions
): ReactTestRenderer {
  const client = createOrcaQueryClient()
  const wrap = (next: ReactElement) => createElement(QueryClientProvider, { client }, next)
  const renderer = create(wrap(element), options)
  const update = renderer.update.bind(renderer)
  const unmount = renderer.unmount.bind(renderer)
  return Object.assign(renderer, {
    update: (next: ReactElement) => update(wrap(next)),
    unmount: () => {
      unmount()
      client.clear()
    }
  })
}
