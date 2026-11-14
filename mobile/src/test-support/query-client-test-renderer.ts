import type { ReactElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { create, type ReactTestRenderer, type TestRendererOptions } from 'react-test-renderer'
import { documentQueryClient } from './rpc-recording/hook-mount'

// TanStack tells observers on a zero-delay timer; a microtask lets act() and fake-timer tests see replies.
notifyManager.setScheduler(queueMicrotask)

/** react-test-renderer's create inside a query client that lives as long as the renderer, as a page document's does. */
export function createWithQueryClient(
  element: ReactElement,
  options?: TestRendererOptions
): ReactTestRenderer {
  const document = documentQueryClient()
  const renderer = create(document.wrap(element), options)
  const update = renderer.update.bind(renderer)
  const unmount = renderer.unmount.bind(renderer)
  return Object.assign(renderer, {
    update: (next: ReactElement) => update(document.wrap(next)),
    unmount: () => {
      unmount()
      void document.end()
    }
  })
}
